import { z } from "zod";
import type { PolicyEvidence, StoredProposal } from "../domain/contracts";

const SLACK_API = "https://slack.com/api";
export const SLACK_POST_TIMEOUT_MS = 8_000;
const definitiveSlackRejections = new Set([
  "invalid_auth",
  "not_authed",
  "missing_scope",
  "channel_not_found",
  "not_in_channel",
  "invalid_arguments",
  "invalid_blocks",
  "no_text",
  "msg_too_long",
  "restricted_action",
  "action_prohibited",
  "is_archived",
  "cant_post_message",
]);
export const SLACK_ACTION_IDS = {
  approve: "ticketpilot_approve",
  reject: "ticketpilot_reject",
  edit: "ticketpilot_edit",
} as const;
export const SLACK_EDIT_MODAL_CALLBACK_ID = "ticketpilot_edit_response";

const targetSchema = z
  .object({
    ticket_id: z.string().regex(/^\d{1,20}$/),
    proposal_hash: z.string().regex(/^[a-f0-9]{64}$/),
    proposal_revision: z.number().int().positive().max(10_000),
  })
  .strict();

const blockActionSchema = z
  .object({
    type: z.literal("block_actions"),
    team: z.object({ id: z.string().regex(/^T[A-Z0-9]+$/) }),
    user: z.object({ id: z.string().regex(/^[UW][A-Z0-9]+$/) }),
    channel: z.object({ id: z.string().regex(/^C[A-Z0-9]+$/) }),
    message: z.object({ ts: z.string().regex(/^\d{1,20}\.\d{1,10}$/) }),
    actions: z
      .array(
        z.object({
          action_id: z.enum([
            SLACK_ACTION_IDS.approve,
            SLACK_ACTION_IDS.reject,
            SLACK_ACTION_IDS.edit,
          ]),
          value: z.string().max(512),
        }),
      )
      .length(1),
  })
  .passthrough();

export type SlackAction = {
  actionId: (typeof SLACK_ACTION_IDS)[keyof typeof SLACK_ACTION_IDS];
  ticketId: string;
  proposalHash: string;
  proposalRevision: number;
  teamId: string;
  actorId: string;
  channelId: string;
  messageTs: string;
  triggerId?: string;
};

export type SlackEditSubmission = {
  ticketId: string;
  proposalHash: string;
  proposalRevision: number;
  teamId: string;
  actorId: string;
  channelId: string;
  messageTs: string;
  draftReply: string;
  summary: string;
  reason: string;
};

export type SlackMessageReceipt = { channelId: string; messageTs: string };

export class SlackApiError extends Error {
  constructor(readonly outcome: "rejected" | "unknown") {
    super(outcome === "rejected" ? "slack_post_rejected" : "slack_post_outcome_unknown");
    this.name = "SlackApiError";
  }
}

export async function readSlackRawBody(request: Request, maxBytes = 64 * 1024): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maxBytes) {
    await request.body?.cancel();
    throw new Error("slack_body_too_large");
  }
  return readBoundedStream(request.body, maxBytes);
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        throw new Error("slack_body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export async function verifySlackSignature(input: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  signingSecret: string;
  nowMs?: number;
}): Promise<boolean> {
  const { rawBody, timestamp, signature, signingSecret } = input;
  if (
    timestamp === null ||
    !/^\d{1,12}$/.test(timestamp) ||
    signature === null ||
    !/^v0=[a-f0-9]{64}$/i.test(signature) ||
    signingSecret.length === 0
  ) {
    return false;
  }
  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1_000);
  if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > 300) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signatureBytes = hexToBytes(signature.slice(3));
  return crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
  );
}

export function parseSlackAction(rawBody: string): SlackAction | null {
  const form = new URLSearchParams(rawBody);
  const values = form.getAll("payload");
  if (values.length !== 1) return null;
  let json: unknown;
  try {
    json = JSON.parse(values[0] ?? "");
  } catch {
    return null;
  }
  const parsed = blockActionSchema.safeParse(json);
  if (!parsed.success) return null;
  const payload = parsed.data;
  const action = payload.actions[0];
  if (action === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(action.value) as unknown;
  } catch {
    return null;
  }
  const target = targetSchema.safeParse(value);
  if (!target.success) return null;
  return {
    actionId: action.action_id,
    ticketId: target.data.ticket_id,
    proposalHash: target.data.proposal_hash,
    proposalRevision: target.data.proposal_revision,
    teamId: payload.team.id,
    actorId: payload.user.id,
    channelId: payload.channel.id,
    messageTs: payload.message.ts,
    ...(typeof payload.trigger_id === "string" ? { triggerId: payload.trigger_id } : {}),
  };
}

const editMetadataSchema = targetSchema
  .extend({
    team_id: z.string().regex(/^T[A-Z0-9]+$/),
    channel_id: z.string().regex(/^C[A-Z0-9]+$/),
    message_ts: z.string().regex(/^\d{1,20}\.\d{1,10}$/),
  })
  .strict();

export function parseSlackEditSubmission(rawBody: string): SlackEditSubmission | null {
  const values = new URLSearchParams(rawBody).getAll("payload");
  if (values.length !== 1) return null;
  try {
    const raw: unknown = JSON.parse(values[0] ?? "");
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const payload = raw as Record<string, unknown>;
    if (payload.type !== "view_submission") return null;
    const team =
      typeof payload.team === "object" && payload.team !== null
        ? (payload.team as Record<string, unknown>)
        : {};
    const user =
      typeof payload.user === "object" && payload.user !== null
        ? (payload.user as Record<string, unknown>)
        : {};
    const view =
      typeof payload.view === "object" && payload.view !== null
        ? (payload.view as Record<string, unknown>)
        : {};
    if (
      view.callback_id !== SLACK_EDIT_MODAL_CALLBACK_ID ||
      typeof view.private_metadata !== "string"
    )
      return null;
    const metadata = editMetadataSchema.safeParse(JSON.parse(view.private_metadata) as unknown);
    if (!metadata.success || typeof team.id !== "string" || typeof user.id !== "string")
      return null;
    const state =
      typeof view.state === "object" && view.state !== null
        ? (view.state as Record<string, unknown>)
        : {};
    const valuesByBlock =
      typeof state.values === "object" && state.values !== null
        ? (state.values as Record<string, unknown>)
        : {};
    const readInput = (block: string, action: string): string | null => {
      const row = valuesByBlock[block];
      if (typeof row !== "object" || row === null) return null;
      const input = (row as Record<string, unknown>)[action];
      if (typeof input !== "object" || input === null) return null;
      const value = (input as Record<string, unknown>).value;
      return typeof value === "string" ? value : value === null ? "" : null;
    };
    const draftReply = readInput("draft_reply_block", "draft_reply");
    const summary = readInput("summary_block", "summary");
    const reason = readInput("reason_block", "reason");
    if (draftReply === null || summary === null || reason === null) return null;
    return {
      ticketId: metadata.data.ticket_id,
      proposalHash: metadata.data.proposal_hash,
      proposalRevision: metadata.data.proposal_revision,
      teamId: team.id,
      actorId: user.id,
      channelId: metadata.data.channel_id,
      messageTs: metadata.data.message_ts,
      draftReply,
      summary,
      reason,
    };
  } catch {
    return null;
  }
}

export type ReviewMessageInput = {
  ticketId: string;
  proposal: StoredProposal;
  evidence: readonly PolicyEvidence[];
};

export function buildReviewMessage(input: ReviewMessageInput): {
  text: string;
  blocks: Record<string, unknown>[];
} {
  const { proposal } = input;
  const target = JSON.stringify({
    ticket_id: input.ticketId,
    proposal_hash: proposal.proposalHash,
    proposal_revision: proposal.revision,
  });
  const supported =
    proposal.evidence_status === "SUPPORTED" &&
    proposal.cited_policy_keys.length > 0 &&
    input.evidence.length > 0 &&
    proposal.draft_reply.trim().length > 0;
  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `TicketPilot review — ${input.ticketId}` },
    },
    {
      type: "section",
      fields: [
        {
          type: "plain_text",
          text: `Revision: ${proposal.revision} (${proposal.revision === 1 ? "AI draft" : "human edited"})`,
        },
        { type: "plain_text", text: `Category: ${proposal.category}` },
        { type: "plain_text", text: `Priority: ${proposal.priority}` },
      ],
    },
    {
      type: "section",
      text: { type: "plain_text", text: `Summary: ${proposal.summary}` },
    },
  ];
  if (supported) {
    blocks.push({
      type: "section",
      text: { type: "plain_text", text: `Draft reply:\n${proposal.draft_reply}` },
    });
  } else {
    blocks.push({
      type: "section",
      text: {
        type: "plain_text",
        text: "Manual review required. No supported policy evidence is available; no reply can be sent.",
      },
    });
  }
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `Policy evidence:\n${formatEvidence(input.evidence)}`,
    },
  });
  if (supported && proposal.revision >= 4) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "plain_text",
          text: "The demo edit limit has been reached. Approve or reject this revision.",
        },
      ],
    });
  }
  blocks.push({
    type: "actions",
    elements: [
      ...(supported && proposal.revision < 4
        ? [
            {
              type: "button",
              action_id: SLACK_ACTION_IDS.edit,
              text: { type: "plain_text", text: "Edit response" },
              value: target,
            },
          ]
        : []),
      ...(supported
        ? [
            {
              type: "button",
              action_id: SLACK_ACTION_IDS.approve,
              text: { type: "plain_text", text: "Approve" },
              style: "primary",
              value: target,
              confirm: {
                title: {
                  type: "plain_text",
                  text: `Approve response revision ${proposal.revision}?`,
                },
                text: {
                  type: "plain_text",
                  text: `This authorizes sending revision ${proposal.revision} as a real demo email to the fixed owner recipient.`,
                },
                confirm: { type: "plain_text", text: "Approve" },
                deny: { type: "plain_text", text: "Cancel" },
              },
            },
          ]
        : []),
      {
        type: "button",
        action_id: SLACK_ACTION_IDS.reject,
        text: { type: "plain_text", text: supported ? "Reject" : "Manual review" },
        style: "danger",
        value: target,
      },
    ],
  });
  return { text: `TicketPilot demo proposal for ticket ${input.ticketId}`, blocks };
}

export class SlackClient {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async postReviewMessage(
    channelId: string,
    input: ReviewMessageInput,
  ): Promise<SlackMessageReceipt> {
    const response = await this.call("chat.postMessage", {
      channel: channelId,
      ...buildReviewMessage(input),
    });
    if (
      !response.ok &&
      (response.status >= 500 || response.status === 408 || response.status === 409)
    ) {
      throw new SlackApiError("unknown");
    }
    const body = await readSlackJson(response);
    if (body === null) throw new SlackApiError("unknown");
    if (body.ok !== true) {
      throw new SlackApiError(
        body.error !== undefined && definitiveSlackRejections.has(body.error)
          ? "rejected"
          : "unknown",
      );
    }
    if (!response.ok) throw new SlackApiError("unknown");
    if (body.channel !== channelId || !validTs(body.ts)) {
      throw new SlackApiError("unknown");
    }
    return { channelId, messageTs: body.ts };
  }

  async updateReviewMessage(
    channelId: string,
    messageTs: string,
    decision: "APPROVE" | "REJECT",
    actorId: string,
  ): Promise<boolean> {
    try {
      const response = await this.call("chat.update", {
        channel: channelId,
        ts: messageTs,
        text: `TicketPilot review: ${decision === "APPROVE" ? "Approved" : "Rejected"} by ${actorId}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "plain_text",
              text: `Decision recorded: ${decision === "APPROVE" ? "approved" : "rejected"} by ${actorId}.`,
            },
          },
        ],
      });
      const body = response.ok ? await readSlackJson(response) : null;
      return body?.ok === true;
    } catch {
      return false;
    }
  }

  async openEditModal(
    triggerId: string,
    input: {
      ticketId: string;
      proposal: StoredProposal;
      teamId: string;
      channelId: string;
      messageTs: string;
    },
  ): Promise<boolean> {
    if (triggerId.length < 1 || triggerId.length > 256) return false;
    const metadata = JSON.stringify({
      ticket_id: input.ticketId,
      proposal_hash: input.proposal.proposalHash,
      proposal_revision: input.proposal.revision,
      team_id: input.teamId,
      channel_id: input.channelId,
      message_ts: input.messageTs,
    });
    const blocks = [
      {
        type: "input",
        block_id: "draft_reply_block",
        label: { type: "plain_text", text: "Response text" },
        element: {
          type: "plain_text_input",
          action_id: "draft_reply",
          multiline: true,
          max_length: 1500,
          initial_value: input.proposal.draft_reply,
        },
      },
      {
        type: "input",
        optional: true,
        block_id: "summary_block",
        label: { type: "plain_text", text: "Internal summary" },
        element: {
          type: "plain_text_input",
          action_id: "summary",
          max_length: 240,
          initial_value: input.proposal.summary,
        },
      },
      {
        type: "input",
        block_id: "reason_block",
        label: { type: "plain_text", text: "Internal reason and solution changes" },
        element: {
          type: "plain_text_input",
          action_id: "reason",
          multiline: true,
          min_length: 1,
          max_length: 200,
          placeholder: {
            type: "plain_text",
            text: "Why was this answer changed? What solution changed?",
          },
        },
      },
    ];
    try {
      const response = await this.call(
        "views.open",
        {
          trigger_id: triggerId,
          view: {
            type: "modal",
            callback_id: SLACK_EDIT_MODAL_CALLBACK_ID,
            private_metadata: metadata,
            title: { type: "plain_text", text: "Edit response" },
            submit: { type: "plain_text", text: "Save revision" },
            close: { type: "plain_text", text: "Cancel" },
            blocks,
          },
        },
        1_500,
      );
      const body = response.ok ? await readSlackJson(response) : null;
      return body?.ok === true;
    } catch {
      return false;
    }
  }

  async refreshReviewMessage(
    channelId: string,
    messageTs: string,
    input: ReviewMessageInput,
  ): Promise<boolean> {
    try {
      const response = await this.call("chat.update", {
        channel: channelId,
        ts: messageTs,
        ...buildReviewMessage(input),
      });
      const body = response.ok ? await readSlackJson(response) : null;
      return body?.ok === true;
    } catch {
      return false;
    }
  }

  private async call(
    method: "chat.postMessage" | "chat.update" | "views.open",
    payload: unknown,
    timeoutMs = SLACK_POST_TIMEOUT_MS,
  ): Promise<Response> {
    try {
      return await this.fetcher(`${SLACK_API}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new SlackApiError("unknown");
    }
  }
}

async function readSlackJson(
  response: Response,
): Promise<{ ok: boolean; channel?: string; ts?: string; error?: string } | null> {
  try {
    const text = await readBoundedStream(response.body, 64 * 1024);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.ok !== "boolean") return null;
    return {
      ok: value.ok,
      ...(typeof value.channel === "string" ? { channel: value.channel } : {}),
      ...(typeof value.ts === "string" ? { ts: value.ts } : {}),
      ...(typeof value.error === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value.error)
        ? { error: value.error }
        : {}),
    };
  } catch {
    return null;
  }
}

function formatEvidence(evidence: readonly PolicyEvidence[]): string {
  if (evidence.length === 0) return "No policy evidence is available.";
  return evidence
    .slice(0, 3)
    .map((item) => {
      let url: URL;
      try {
        url = new URL(item.url);
      } catch {
        return `• ${escapeMrkdwn(item.title)}`;
      }
      if (url.protocol !== "https:" || !["notion.so", "www.notion.so"].includes(url.hostname)) {
        return `• ${escapeMrkdwn(item.title)}`;
      }
      return `• <${url.toString()}|${escapeMrkdwn(item.title)}>`;
    })
    .join("\n");
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function validTs(value: unknown): value is string {
  return typeof value === "string" && /^\d{1,20}\.\d{1,10}$/.test(value);
}

function hexToBytes(value: string): ArrayBuffer {
  const buffer = new ArrayBuffer(value.length / 2);
  const bytes = new DataView(buffer);
  for (let index = 0; index < buffer.byteLength; index += 1) {
    bytes.setUint8(index, Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
  }
  return buffer;
}
