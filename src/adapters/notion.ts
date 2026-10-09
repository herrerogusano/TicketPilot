import { z } from "zod";
import type { PolicyDocument, PolicyKey } from "../domain/contracts";

export const NOTION_VERSION = "2026-03-11";
const API_ROOT = "https://api.notion.com/v1";
const PAGE_SIZE = 50;
const BLOCK_PAGE_SIZE = 25;
const MAX_PARENT_PAGES = 3;
const MAX_BLOCK_PAGES = 2;
const MAX_POLICY_BLOCKS = 50;
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_INTERVAL_MS = 350;

const richTextSchema = z.array(
  z
    .object({
      plain_text: z.string().optional(),
      text: z.object({ content: z.string().optional() }).optional(),
    })
    .passthrough(),
);

const pageSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  in_trash: z.boolean().optional(),
  parent: z.object({ page_id: z.string().optional() }).passthrough(),
  properties: z.record(z.string(), z.unknown()),
});

const childrenSchema = z.object({
  results: z.array(
    z
      .object({
        id: z.string().min(1),
        type: z.string(),
        has_children: z.boolean().optional(),
        child_page: z.object({ title: z.string() }).optional(),
      })
      .passthrough(),
  ),
  has_more: z.boolean(),
  next_cursor: z.string().nullable().optional(),
});

export type NotionPageRef = { id: string; key: PolicyKey; title: string; url: string };
export type NotionPolicySeed = {
  key: PolicyKey;
  title: string;
  sections: readonly { heading: string; text: string }[];
};

export class NotionError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
    this.name = "NotionError";
  }
}

export class NotionClient {
  private requestTail: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;
  private hasRequested = false;

  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = delay,
    private readonly beforeRequest?: () => Promise<void>,
  ) {}

  async listChildPages(parentPageId: string): Promise<NotionPageRef[]> {
    const parent = normalizeNotionId(parentPageId);
    const refs: NotionPageRef[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PARENT_PAGES; page += 1) {
      const query = new URLSearchParams({ page_size: String(PAGE_SIZE) });
      if (cursor !== undefined) query.set("start_cursor", cursor);
      const raw = await this.request(`/blocks/${encodeURIComponent(parent)}/children?${query}`);
      const parsed = childrenSchema.safeParse(raw);
      if (!parsed.success) throw new NotionError("invalid_children_response");
      for (const block of parsed.data.results) {
        if (block.type !== "child_page" || block.child_page === undefined) continue;
        const key = policyKeyFromTitle(block.child_page.title);
        if (key !== undefined) {
          refs.push({ id: block.id, key, title: block.child_page.title, url: "" });
        }
      }
      if (!parsed.data.has_more) return refs;
      cursor = parsed.data.next_cursor ?? undefined;
      if (cursor === undefined) throw new NotionError("missing_pagination_cursor");
    }
    throw new NotionError("parent_page_pagination_limit");
  }

  async retrievePolicy(ref: NotionPageRef, expectedParentId: string): Promise<PolicyDocument> {
    const rawPage = await this.request(`/pages/${encodeURIComponent(ref.id)}`);
    const parsedPage = pageSchema.safeParse(rawPage);
    if (!parsedPage.success) throw new NotionError("invalid_page_response");
    const page = parsedPage.data;
    if (
      page.in_trash === true ||
      normalizeNotionId(page.parent.page_id ?? "") !== normalizeNotionId(expectedParentId)
    ) {
      throw new NotionError("policy_page_not_active_child");
    }
    const title = pageTitle(page.properties);
    if (title === undefined) throw new NotionError("policy_page_title_missing");
    if (policyKeyFromTitle(title) !== ref.key) throw new NotionError("policy_key_mismatch");

    const textParts: string[] = [];
    let blockCount = 0;
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_BLOCK_PAGES; pageIndex += 1) {
      const query = new URLSearchParams({ page_size: String(BLOCK_PAGE_SIZE) });
      if (cursor !== undefined) query.set("start_cursor", cursor);
      const rawChildren = await this.request(
        `/blocks/${encodeURIComponent(ref.id)}/children?${query}`,
      );
      const parsed = childrenSchema.safeParse(rawChildren);
      if (!parsed.success) throw new NotionError("invalid_policy_blocks_response");
      blockCount += parsed.data.results.length;
      if (blockCount > MAX_POLICY_BLOCKS) {
        throw new NotionError("policy_block_limit");
      }
      for (const block of parsed.data.results) {
        const text = blockPlainText(block);
        if (text.length > 0) textParts.push(text);
      }
      if (!parsed.data.has_more) break;
      cursor = parsed.data.next_cursor ?? undefined;
      if (cursor === undefined) throw new NotionError("missing_policy_block_cursor");
      if (pageIndex === MAX_BLOCK_PAGES - 1) throw new NotionError("policy_block_limit");
    }
    const content = textParts.join("\n").slice(0, 8_000);
    return {
      key: ref.key,
      title,
      url: page.url,
      content,
      contentHash: await sha256(content),
    };
  }

  async createPolicyPage(parentPageId: string, seed: NotionPolicySeed): Promise<string> {
    const title = formatPolicyTitle(seed.key, seed.title);
    const body = {
      parent: { type: "page_id", page_id: normalizeNotionId(parentPageId) },
      properties: {
        title: {
          title: [{ type: "text", text: { content: title } }],
        },
      },
      children: seed.sections
        .map((section) => ({
          object: "block",
          type: "heading_2",
          heading_2: { rich_text: [{ type: "text", text: { content: section.heading } }] },
        }))
        .flatMap((heading, index) => {
          const section = seed.sections[index];
          if (section === undefined) return [heading];
          return [
            heading,
            {
              object: "block",
              type: "paragraph",
              paragraph: { rich_text: [{ type: "text", text: { content: section.text } }] },
            },
          ];
        }),
    };
    const raw = await this.request("/pages", { method: "POST", body: JSON.stringify(body) });
    const parsed = pageSchema.safeParse(raw);
    if (!parsed.success) throw new NotionError("invalid_create_page_response");
    return parsed.data.id;
  }

  private async request(
    path: string,
    init: { method?: "GET" | "POST"; body?: string } = {},
  ): Promise<unknown> {
    const previous = this.requestTail;
    let release: () => void = () => undefined;
    this.requestTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.beforeRequest !== undefined) {
        await this.beforeRequest();
      } else {
        const waitMs = Math.max(0, REQUEST_INTERVAL_MS - (this.now() - this.lastRequestAt));
        if (this.hasRequested && waitMs > 0) await this.sleep(waitMs);
      }
      this.lastRequestAt = this.now();
      this.hasRequested = true;
      let response: Response;
      try {
        response = await this.fetcher(`${API_ROOT}${path}`, {
          method: init.method ?? "GET",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Notion-Version": NOTION_VERSION,
            Accept: "application/json",
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(init.body === undefined ? {} : { body: init.body }),
          signal: AbortSignal.timeout(8_000),
        });
      } catch {
        throw new NotionError("notion_network_error");
      }
      if (!response.ok) throw new NotionError("notion_request_failed", response.status);
      const text = await boundedText(response, MAX_RESPONSE_BYTES);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new NotionError("notion_invalid_json");
      }
    } finally {
      release();
    }
  }
}

export function normalizeNotionId(value: string): string {
  const normalized = value.replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) throw new NotionError("invalid_notion_id");
  return normalized;
}

export function formatPolicyTitle(key: PolicyKey, title: string): string {
  return `[TP-KB:${key}] ${title}`;
}

export function policyKeyFromTitle(title: string): PolicyKey | undefined {
  const match = /^\[TP-KB:([a-z-]+)\]/.exec(title);
  const key = match?.[1];
  return key === "billing-double-charge" ||
    key === "premium-activation" ||
    key === "password-reset" ||
    key === "export-csv" ||
    key === "incident-escalation"
    ? key
    : undefined;
}

function pageTitle(properties: Record<string, unknown>): string | undefined {
  const value = properties.title;
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>).title;
  const parsed = richTextSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  return parsed.data.map((item) => item.plain_text ?? item.text?.content ?? "").join("");
}

function blockPlainText(block: Record<string, unknown>): string {
  const type = block.type;
  if (typeof type !== "string") return "";
  const data = block[type];
  if (typeof data !== "object" || data === null) return "";
  const raw = (data as Record<string, unknown>).rich_text;
  const parsed = richTextSchema.safeParse(raw);
  if (!parsed.success) return "";
  return parsed.data
    .map((item) => item.plain_text ?? item.text?.content ?? "")
    .join("")
    .trim();
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new NotionError("notion_response_too_large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
