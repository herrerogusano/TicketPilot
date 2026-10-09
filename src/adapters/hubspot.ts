import { z } from "zod";
import { limits } from "../platform/config";

const ticketSchema = z.object({
  id: z.string().regex(/^\d+$/),
  createdAt: z.string().min(1),
  properties: z.record(z.string(), z.unknown()),
});

const ticketSearchSchema = z.object({
  results: z.array(ticketSchema),
  paging: z.object({ next: z.object({ after: z.string().min(1) }).optional() }).optional(),
});

const ticketDetailSchema = ticketSchema;

const pipelineListSchema = z.object({
  results: z.array(
    z.object({
      id: z.string().min(1),
      archived: z.boolean().optional(),
      displayOrder: z.number().int().nonnegative(),
      stages: z.array(
        z.object({
          id: z.string().min(1),
          archived: z.boolean().optional(),
          displayOrder: z.number().int().nonnegative(),
        }),
      ),
    }),
  ),
});

const ticketCreateSchema = z.object({ id: z.string().regex(/^\d+$/) });

const noteCreateSchema = z.object({ id: z.string().regex(/^\d+$/) });

const noteReadSchema = z.object({
  id: z.string().regex(/^\d+$/),
  properties: z.record(z.string(), z.unknown()),
  associations: z
    .object({
      tickets: z
        .object({ results: z.array(z.object({ id: z.string().regex(/^\d+$/) })) })
        .optional(),
    })
    .optional(),
});

export type HubSpotTicket = {
  id: string;
  createdAt: string;
  createdAtMs: number;
  subject: string;
  content: string;
};

export type HubSpotTicketCreate = {
  subject: string;
  content: string;
  pipelineId: string;
  stageId: string;
};

export type HubSpotTicketPipeline = { id: string; stageId: string };

type Fetcher = typeof fetch;

const apiRoot = "https://api.hubapi.com";
const responseLimitBytes = 512 * 1024;
const timeoutMs = 8_000;
const maxReadAttempts = 3;
const maxNoteAssociations = 10;

export class HubSpotError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "HubSpotError";
  }
}

export class HubSpotClient {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetcher = (input, init) => globalThis.fetch(input, init),
  ) {}

  async searchDemoTickets(cutoff: string): Promise<HubSpotTicket[]> {
    const cutoffMs = Date.parse(cutoff);
    if (!Number.isFinite(cutoffMs)) throw new HubSpotError("invalid_cutoff");

    const eligible: HubSpotTicket[] = [];
    let after: string | undefined;
    for (let page = 0; page < limits.maxPollPages; page += 1) {
      const filters = [{ propertyName: "createdate", operator: "GTE", value: String(cutoffMs) }];
      const body: Record<string, unknown> = {
        filterGroups: [{ filters }],
        sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
        properties: ["subject", "content", "createdate"],
        limit: 100,
      };
      if (after !== undefined) body.after = after;
      const raw = await this.readJson("/crm/v3/objects/tickets/search", "POST", body);
      const parsed = ticketSearchSchema.safeParse(raw);
      if (!parsed.success) throw new HubSpotError("invalid_search_response");

      for (const item of parsed.data.results) {
        const subject = stringProperty(item.properties.subject);
        const content = stringProperty(item.properties.content);
        const propertyCreatedAt = parseHubSpotDate(item.properties.createdate);
        const recordCreatedAt = Date.parse(item.createdAt);
        if (
          subject === undefined ||
          content === undefined ||
          propertyCreatedAt === undefined ||
          !Number.isFinite(recordCreatedAt) ||
          propertyCreatedAt < cutoffMs ||
          recordCreatedAt < cutoffMs ||
          !subject.startsWith("[TP-DEMO]")
        ) {
          continue;
        }
        eligible.push({
          id: item.id,
          createdAt: new Date(Math.min(propertyCreatedAt, recordCreatedAt)).toISOString(),
          createdAtMs: Math.min(propertyCreatedAt, recordCreatedAt),
          subject: subject.slice(0, limits.maxTicketTitleLength),
          content: content.trim().slice(0, limits.maxTicketBodyLength),
        });
      }
      after = parsed.data.paging?.next?.after;
      if (after === undefined) break;
    }
    return eligible;
  }

  async getTicket(id: string): Promise<HubSpotTicket | null> {
    assertTicketId(id);
    const raw = await this.readJson(
      `/crm/v3/objects/tickets/${encodeURIComponent(id)}?properties=subject,content,createdate`,
    );
    if (raw === null) return null;
    const parsed = ticketDetailSchema.safeParse(raw);
    if (!parsed.success) throw new HubSpotError("invalid_ticket_response");
    const subject = stringProperty(parsed.data.properties.subject);
    const content = stringProperty(parsed.data.properties.content);
    const propertyCreatedAtMs = parseHubSpotDate(parsed.data.properties.createdate);
    const outerCreatedAtMs = Date.parse(parsed.data.createdAt);
    if (
      subject === undefined ||
      content === undefined ||
      propertyCreatedAtMs === undefined ||
      !Number.isFinite(outerCreatedAtMs)
    ) {
      throw new HubSpotError("incomplete_ticket_response");
    }
    return {
      id: parsed.data.id,
      createdAt: new Date(Math.min(propertyCreatedAtMs, outerCreatedAtMs)).toISOString(),
      createdAtMs: Math.min(propertyCreatedAtMs, outerCreatedAtMs),
      subject: subject.slice(0, limits.maxTicketTitleLength),
      content: content.trim().slice(0, limits.maxTicketBodyLength),
    };
  }

  async createTicket(input: HubSpotTicketCreate): Promise<string> {
    const raw = await this.writeJson("/crm/v3/objects/tickets", {
      properties: {
        subject: input.subject.slice(0, limits.maxTicketTitleLength),
        content: input.content.slice(0, limits.maxTicketBodyLength),
        hs_pipeline: input.pipelineId,
        hs_pipeline_stage: input.stageId,
      },
    });
    const parsed = ticketCreateSchema.safeParse(raw);
    if (!parsed.success) throw new HubSpotError("invalid_ticket_create_response");
    return parsed.data.id;
  }

  async getFirstActivePipeline(
    pipelineOverride?: string,
    stageOverride?: string,
  ): Promise<HubSpotTicketPipeline> {
    const raw = await this.readJson("/crm/v3/pipelines/tickets");
    const parsed = pipelineListSchema.safeParse(raw);
    if (!parsed.success) throw new HubSpotError("invalid_pipeline_response");
    const pipelines = parsed.data.results
      .filter((pipeline) => pipeline.archived !== true)
      .sort((left, right) => left.displayOrder - right.displayOrder);
    const selectedPipeline =
      pipelineOverride === undefined
        ? undefined
        : pipelines.find((pipeline) => pipeline.id === pipelineOverride);
    const candidates =
      selectedPipeline === undefined
        ? pipelineOverride === undefined
          ? pipelines
          : []
        : [selectedPipeline];
    for (const pipeline of candidates) {
      const stage = pipeline.stages
        .filter((candidate) => candidate.archived !== true)
        .sort((left, right) => left.displayOrder - right.displayOrder)
        .find((candidate) => stageOverride === undefined || candidate.id === stageOverride);
      if (stage !== undefined) return { id: pipeline.id, stageId: stage.id };
    }
    throw new HubSpotError("no_active_ticket_pipeline");
  }

  async createNote(ticketId: string, body: string): Promise<string> {
    assertTicketId(ticketId);
    const associationTypes = await this.readJson("/crm/associations/2026-09/notes/tickets/labels");
    const associationType = findAssociationType(associationTypes);
    if (associationType === undefined) throw new HubSpotError("note_association_type_unavailable");
    const raw = await this.writeJson("/crm/v3/objects/notes", {
      properties: { hs_note_body: body, hs_timestamp: new Date().toISOString() },
      associations: [
        {
          to: { id: ticketId },
          types: [
            {
              associationCategory: associationType.category,
              associationTypeId: associationType.id,
            },
          ],
        },
      ],
    });
    const parsed = noteCreateSchema.safeParse(raw);
    if (!parsed.success) throw new HubSpotError("invalid_note_create_response");
    return parsed.data.id;
  }

  async findAssociatedNote(ticketId: string, marker: string): Promise<string | null> {
    assertTicketId(ticketId);
    const raw = await this.readJson(
      `/crm/v3/objects/tickets/${encodeURIComponent(ticketId)}?associations=notes`,
    );
    const parsed = z
      .object({
        associations: z
          .object({
            notes: z
              .object({
                results: z.array(z.object({ id: z.string().regex(/^\d+$/) })),
                paging: z.object({ next: z.object({ after: z.string() }).optional() }).optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .safeParse(raw);
    if (!parsed.success) throw new HubSpotError("invalid_ticket_associations_response");
    const associations = parsed.data.associations?.notes;
    if (
      associations?.paging?.next !== undefined ||
      (associations?.results.length ?? 0) > maxNoteAssociations
    ) {
      throw new HubSpotError("too_many_associated_notes");
    }
    const matches: string[] = [];
    for (const association of associations?.results ?? []) {
      const noteRaw = await this.readJson(
        `/crm/v3/objects/notes/${encodeURIComponent(association.id)}?properties=hs_note_body&associations=tickets`,
      );
      const note = noteReadSchema.safeParse(noteRaw);
      if (
        note.success &&
        typeof note.data.properties.hs_note_body === "string" &&
        note.data.properties.hs_note_body.includes(marker) &&
        note.data.associations?.tickets?.results.some((item) => item.id === ticketId)
      ) {
        matches.push(note.data.id);
      }
    }
    if (matches.length > 1) throw new HubSpotError("duplicate_audit_marker_matches");
    return matches[0] ?? null;
  }

  async verifyAssociatedNote(ticketId: string, noteId: string, marker: string): Promise<boolean> {
    assertTicketId(ticketId);
    assertTicketId(noteId);
    const raw = await this.readJson(
      `/crm/v3/objects/notes/${encodeURIComponent(noteId)}?properties=hs_note_body&associations=tickets`,
    );
    if (raw === null) return false;
    const parsed = noteReadSchema.safeParse(raw);
    return (
      parsed.success &&
      parsed.data.id === noteId &&
      typeof parsed.data.properties.hs_note_body === "string" &&
      parsed.data.properties.hs_note_body.includes(marker) &&
      parsed.data.associations?.tickets?.results.some((item) => item.id === ticketId) === true
    );
  }

  private async readJson(
    path: string,
    method: "GET" | "POST" = "GET",
    body?: unknown,
  ): Promise<unknown> {
    return this.requestJson(path, method, body, true);
  }

  private async writeJson(path: string, body: unknown): Promise<unknown> {
    return this.requestJson(path, "POST", body, false);
  }

  private async requestJson(
    path: string,
    method: "GET" | "POST",
    body: unknown,
    retryRead: boolean,
  ): Promise<unknown> {
    const attempts = retryRead ? maxReadAttempts : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetcher(`${apiRoot}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (retryRead && attempt + 1 < attempts) {
          await delay(100 * (attempt + 1));
          continue;
        }
        throw new HubSpotError("hubspot_network_error", undefined, retryRead);
      }
      if (response.status === 404 && method === "GET") return null;
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryRead && retryable && attempt + 1 < attempts) {
          await delay(retryDelay(response.headers.get("Retry-After"), attempt));
          continue;
        }
        throw new HubSpotError("hubspot_request_failed", response.status, retryable);
      }
      const text = await readBoundedText(response);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new HubSpotError("invalid_json_response");
      }
    }
    throw new HubSpotError("hubspot_request_failed");
  }
}

function stringProperty(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseHubSpotDate(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function assertTicketId(id: string): void {
  if (!/^\d+$/.test(id)) throw new HubSpotError("invalid_ticket_id");
}

function findAssociationType(raw: unknown): { category: string; id: number } | undefined {
  const parsed = z
    .object({
      results: z.array(
        z.object({
          category: z.string().min(1),
          label: z.string().nullable().optional(),
          typeId: z.number().int().positive(),
        }),
      ),
    })
    .safeParse(raw);
  if (!parsed.success) return undefined;
  const found = parsed.data.results.find(
    (type) => type.category === "HUBSPOT_DEFINED" && type.label === null,
  );
  return found === undefined ? undefined : { category: found.category, id: found.typeId };
}

function retryDelay(retryAfter: string | null, attempt: number): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1_000, 100), 1_500);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.min(Math.max(dateDelay, 100), 1_500);
  }
  return 100 * (attempt + 1);
}

async function readBoundedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > responseLimitBytes) {
    throw new HubSpotError("response_too_large");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > responseLimitBytes) {
      await reader.cancel();
      throw new HubSpotError("response_too_large");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
