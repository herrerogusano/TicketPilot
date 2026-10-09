import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { HubSpotClient } from "../src/adapters/hubspot";

export const projectRoot = resolve(import.meta.dirname, "..");
export const workerUrl = "https://ticketpilot-api.herrerogusano-ticketpilot.workers.dev";
const ticketId = z.string().regex(/^\d{1,20}$/);
const manifestSchema = z.object({
  version: z.literal(1),
  cases: z.record(z.string(), z.object({ status: z.literal("created"), ticketId })),
});

export function requireDemo(): void {
  if (process.env.TICKETPILOT_ENV !== "demo") throw new Error("demo_configuration_required");
}

export function configured(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || /^replace-/i.test(value)) throw new Error("configuration_missing");
  return value;
}

export async function seedIds(): Promise<Record<string, string>> {
  const raw = await readFile(resolve(projectRoot, "seed-manifest-hubspot.json"), "utf8");
  const manifest = manifestSchema.parse(JSON.parse(raw));
  const entries = Object.entries(manifest.cases);
  if (entries.length !== 5 || new Set(entries.map(([, item]) => item.ticketId)).size !== 5) {
    throw new Error("five_unique_seed_ids_required");
  }
  return Object.fromEntries(entries.map(([key, item]) => [key, item.ticketId]));
}

export function readDemoLedger(ids: readonly string[]): Record<string, unknown>[] {
  const validated = z.array(ticketId).min(1).max(5).parse(ids);
  const sql = `SELECT hubspot_ticket_id,state,evidence_status,proposal_hash,slack_post_status,
    slack_post_attempts,slack_message_ts,proposal_revision,decision,decision_by,decision_at,
    resend_message_id,resend_attempts,hubspot_note_id,crm_audit_status,crm_audit_marker,
    crm_audit_candidate_note_id,
    (SELECT COUNT(*) FROM events WHERE ticket_id=tickets.hubspot_ticket_id
      AND event_type='EMAIL_ACCEPTED') AS acceptance_event_count,
    (SELECT COUNT(*) FROM events WHERE ticket_id=tickets.hubspot_ticket_id
      AND event_type='CRM_AUDIT_COMPLETED') AS audit_event_count
    FROM tickets
    WHERE hubspot_ticket_id IN (${validated.map((id) => `'${id}'`).join(",")})
    ORDER BY hubspot_ticket_id;`;
  return readRemoteRows(sql);
}

// Callers construct SQL only from validated IDs; raw rows are never logged.
export function readRemoteRows(sql: string): Record<string, unknown>[] {
  let output: string;
  try {
    output = execFileSync(
      process.execPath,
      [
        resolve(projectRoot, "node_modules/wrangler/bin/wrangler.js"),
        "d1",
        "execute",
        "ticketpilot-db",
        "--remote",
        "--command",
        sql,
        "--json",
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1_048_576,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    throw new Error("remote_ledger_read_failed");
  }
  const results = z
    .array(
      z.object({ success: z.literal(true), results: z.array(z.record(z.string(), z.unknown())) }),
    )
    .parse(JSON.parse(output));
  return results.flatMap((result) => result.results);
}

export async function readJson(url: string, token?: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("provider_read_failed");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("provider_response_missing");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 262_144) {
      await reader.cancel();
      throw new Error("provider_response_too_large");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as unknown;
}

export function assertHealth(raw: unknown): void {
  z.object({ ok: z.literal(true), configured: z.literal(true), version: z.string() }).parse(raw);
}

export async function verifyNoteAssociation(
  noteId: string,
  expectedTicketId: string,
  marker: string,
  receipt: string,
): Promise<boolean> {
  ticketId.parse(noteId);
  ticketId.parse(expectedTicketId);
  const raw = await readJson(
    `https://api.hubapi.com/crm/v3/objects/notes/${noteId}?properties=hs_note_body&associations=tickets`,
    configured("HUBSPOT_SERVICE_KEY"),
  );
  const note = z
    .object({
      id: ticketId,
      properties: z.object({ hs_note_body: z.string() }),
      associations: z.object({
        tickets: z.object({ results: z.array(z.object({ id: ticketId })) }),
      }),
    })
    .safeParse(raw);
  const matched =
    note.success &&
    note.data.id === noteId &&
    note.data.properties.hs_note_body.includes(marker) &&
    note.data.properties.hs_note_body.includes(`Resend message ID: ${receipt}`) &&
    note.data.associations.tickets.results.some((item) => item.id === expectedTicketId);
  if (!matched) return false;
  return (
    (await new HubSpotClient(configured("HUBSPOT_SERVICE_KEY")).findAssociatedNote(
      expectedTicketId,
      marker,
    )) === noteId
  );
}
