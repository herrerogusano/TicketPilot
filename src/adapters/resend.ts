import { z } from "zod";
import type { StoredProposal } from "../domain/contracts";

const apiEndpoint = "https://api.resend.com/emails";
const requestTimeoutMs = 8_000;
const responseLimitBytes = 64 * 1024;
const maxRetryAfterMs = 10 * 60 * 1_000;

const sendResponseSchema = z.object({ id: z.string().min(1).max(200) });
export const immutableEmailPayloadSchema = z.object({
  from: z.literal("TicketPilot Demo <onboarding@resend.dev>"),
  to: z.tuple([z.email()]),
  subject: z.string().min(1).max(240),
  text: z.string().min(1).max(4_000),
});

export type ImmutableEmailPayload = {
  from: "TicketPilot Demo <onboarding@resend.dev>";
  to: [string];
  subject: string;
  text: string;
};

export type ResendSendResult =
  | { kind: "accepted"; messageId: string }
  | { kind: "rate_limited"; retryAfterMs: number | null }
  | { kind: "rejected" }
  | { kind: "unknown" };

export function buildImmutableEmailPayload(
  ticketId: string,
  proposal: StoredProposal,
  recipient: string,
): ImmutableEmailPayload {
  if (!/^\d+$/.test(ticketId)) throw new Error("invalid_ticket_id");
  if (proposal.evidence_status !== "SUPPORTED" || proposal.draft_reply.trim() === "") {
    throw new Error("email_requires_supported_proposal");
  }
  const subject = `[TicketPilot DEMO] Ticket ${ticketId} — Response`;
  const text = [
    `Ticket ${ticketId}`,
    `Category: ${proposal.category}`,
    `Priority: ${proposal.priority}`,
    `Summary: ${proposal.summary}`,
    "",
    proposal.draft_reply,
  ].join("\n");
  return {
    from: "TicketPilot Demo <onboarding@resend.dev>",
    to: [recipient],
    subject,
    text,
  };
}

export async function hashEmailPayload(payload: ImmutableEmailPayload): Promise<string> {
  const canonical = JSON.stringify({
    from: payload.from,
    to: [...payload.to],
    subject: payload.subject,
    text: payload.text,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseImmutableEmailPayload(value: unknown): ImmutableEmailPayload | null {
  const parsed = immutableEmailPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export class ResendClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async send(payload: ImmutableEmailPayload, idempotencyKey: string): Promise<ResendSendResult> {
    if (idempotencyKey.length < 1 || idempotencyKey.length > 256) {
      throw new Error("invalid_idempotency_key");
    }
    let response: Response;
    try {
      response = await this.fetcher(apiEndpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch {
      return { kind: "unknown" };
    }

    if (response.status === 429) {
      return {
        kind: "rate_limited",
        retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")),
      };
    }
    if (response.status === 409 || response.status === 408 || response.status >= 500) {
      return { kind: "unknown" };
    }
    if ([400, 401, 403, 404, 422].includes(response.status)) return { kind: "rejected" };
    if (!response.ok) return { kind: "unknown" };

    let body: unknown;
    try {
      body = JSON.parse(await readBoundedText(response)) as unknown;
    } catch {
      return { kind: "unknown" };
    }
    const parsed = sendResponseSchema.safeParse(body);
    return parsed.success ? { kind: "accepted", messageId: parsed.data.id } : { kind: "unknown" };
  }
}

function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  let delayMs: number;
  if (Number.isFinite(seconds) && seconds >= 0) {
    delayMs = seconds * 1_000;
  } else {
    const dateMs = Date.parse(value);
    if (!Number.isFinite(dateMs)) return null;
    delayMs = Math.max(0, dateMs - now);
  }
  if (!Number.isFinite(delayMs) || delayMs > maxRetryAfterMs) return null;
  return Math.max(100, Math.trunc(delayMs));
}

async function readBoundedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > responseLimitBytes) {
    throw new Error("resend_response_too_large");
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
      throw new Error("resend_response_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
