import { describe, expect, it, vi } from "vitest";
import {
  buildReviewMessage,
  parseSlackAction,
  parseSlackEditSubmission,
  readSlackRawBody,
  SLACK_ACTION_IDS,
  SLACK_EDIT_MODAL_CALLBACK_ID,
  type SlackApiError,
  SlackClient,
  verifySlackSignature,
} from "../src/adapters/slack";
import type { PolicyEvidence, StoredProposal } from "../src/domain/contracts";

const secret = "0123456789abcdef0123456789abcdef";
const nowMs = Date.UTC(2026, 9, 9, 12, 0, 0);
const timestamp = String(Math.floor(nowMs / 1_000));
const supportedProposal: StoredProposal = {
  category: "BILLING",
  priority: "MEDIUM",
  evidence_status: "SUPPORTED",
  summary: "A duplicate charge will be reviewed.",
  draft_reply: "We can review the dates and amounts.",
  cited_policy_keys: ["billing-double-charge"],
  rationale: "The policy supports a billing review.",
  proposalHash: "a".repeat(64),
  revision: 1,
  promptVersion: "ticketpilot-v1",
  policyEvidence: [],
};
const evidence: PolicyEvidence[] = [
  {
    key: "billing-double-charge",
    title: "[TP-KB:billing-double-charge] Duplicate billing",
    url: "https://www.notion.so/demo-policy",
    contentHash: "b".repeat(64),
  },
];

async function sign(rawBody: string, at = timestamp): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${at}:${rawBody}`),
  );
  return `v0=${Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function interactionPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "block_actions",
    team: { id: "T0C7S09984V" },
    user: { id: "U0C7X45H86N" },
    channel: { id: "C0C7X4Y182E" },
    message: { ts: "1791547200.000001" },
    actions: [
      {
        action_id: SLACK_ACTION_IDS.approve,
        value: JSON.stringify({
          ticket_id: "7001",
          proposal_hash: supportedProposal.proposalHash,
          proposal_revision: supportedProposal.revision,
        }),
      },
    ],
    ...overrides,
  };
}

function formBody(payload: unknown): string {
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

describe("Phase 3 Slack signature and interaction adapter", () => {
  it("verifies v0 signatures over exact raw form bytes and rejects altered or stale bodies", async () => {
    const raw = formBody(interactionPayload());
    const signature = await sign(raw);
    await expect(
      verifySlackSignature({ rawBody: raw, timestamp, signature, signingSecret: secret, nowMs }),
    ).resolves.toBe(true);
    await expect(
      verifySlackSignature({
        rawBody: `${raw}&extra=1`,
        timestamp,
        signature,
        signingSecret: secret,
        nowMs,
      }),
    ).resolves.toBe(false);
    await expect(
      verifySlackSignature({
        rawBody: raw,
        timestamp: String(Number(timestamp) - 301),
        signature,
        signingSecret: secret,
        nowMs,
      }),
    ).resolves.toBe(false);
    await expect(
      verifySlackSignature({
        rawBody: raw,
        timestamp: String(Number(timestamp) + 301),
        signature,
        signingSecret: secret,
        nowMs,
      }),
    ).resolves.toBe(false);
    await expect(
      verifySlackSignature({
        rawBody: raw,
        timestamp,
        signature: "v1=bad",
        signingSecret: secret,
        nowMs,
      }),
    ).resolves.toBe(false);
  });

  it("preserves a UTF-8 BOM in the signed raw bytes instead of normalizing it away", async () => {
    const raw = formBody(interactionPayload());
    const signature = await sign(raw);
    const request = new Request("https://ticketpilot.example/slack/actions", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: raw,
    });
    const decoded = await readSlackRawBody(request);
    const bomPrefixed = `\uFEFF${decoded}`;
    await expect(
      verifySlackSignature({
        rawBody: bomPrefixed,
        timestamp,
        signature,
        signingSecret: secret,
        nowMs,
      }),
    ).resolves.toBe(false);
    expect(decoded).toBe(raw);
  });

  it("parses only one bounded block-action payload and binds proposal identity from its button value", () => {
    const parsed = parseSlackAction(formBody(interactionPayload()));
    expect(parsed).toEqual({
      actionId: SLACK_ACTION_IDS.approve,
      ticketId: "7001",
      proposalHash: supportedProposal.proposalHash,
      proposalRevision: 1,
      teamId: "T0C7S09984V",
      actorId: "U0C7X45H86N",
      channelId: "C0C7X4Y182E",
      messageTs: "1791547200.000001",
    });
    expect(parseSlackAction(`${formBody(interactionPayload())}&payload=%7B%7D`)).toBeNull();
    expect(parseSlackAction("payload=%7B%22type%22%3A%22url_verification%22%7D")).toBeNull();
    const invalidValue = interactionPayload({
      actions: [{ action_id: SLACK_ACTION_IDS.approve, value: "{}" }],
    });
    expect(parseSlackAction(formBody(invalidValue))).toBeNull();
  });

  it("parses signed modal metadata and treats a null optional summary as unchanged", () => {
    const modal = {
      type: "view_submission",
      team: { id: "T0C7S09984V" },
      user: { id: "U0C7X45H86N" },
      view: {
        callback_id: SLACK_EDIT_MODAL_CALLBACK_ID,
        private_metadata: JSON.stringify({
          ticket_id: "7001",
          proposal_hash: supportedProposal.proposalHash,
          proposal_revision: 1,
          team_id: "T0C7S09984V",
          channel_id: "C0C7X4Y182E",
          message_ts: "1791547200.000001",
        }),
        state: {
          values: {
            draft_reply_block: { draft_reply: { value: "Revised response" } },
            summary_block: { summary: { value: null } },
            reason_block: { reason: { value: "Clarified the proposed solution." } },
          },
        },
      },
    };
    expect(parseSlackEditSubmission(formBody(modal))).toMatchObject({
      ticketId: "7001",
      proposalHash: supportedProposal.proposalHash,
      proposalRevision: 1,
      draftReply: "Revised response",
      summary: "",
      reason: "Clarified the proposed solution.",
    });
    expect(parseSlackEditSubmission(`${formBody(modal)}&payload=%7B%7D`)).toBeNull();
  });

  it("builds a Block Kit review with deterministic target identity and never shows Approve without evidence", () => {
    const message = buildReviewMessage({ ticketId: "7001", proposal: supportedProposal, evidence });
    expect(message.text).toContain("7001");
    const actions = message.blocks.find((block) => block.type === "actions");
    expect(actions).toBeDefined();
    const elements = actions?.elements;
    expect(elements).toContainEqual(
      expect.objectContaining({ action_id: SLACK_ACTION_IDS.approve }),
    );
    expect(JSON.stringify(elements)).toContain(supportedProposal.proposalHash);
    expect(JSON.stringify(elements)).toContain("real demo email to the fixed owner recipient");
    expect(JSON.stringify(elements)).toContain(SLACK_ACTION_IDS.edit);

    const atLimit = buildReviewMessage({
      ticketId: "7001",
      proposal: { ...supportedProposal, revision: 4 },
      evidence,
    });
    const atLimitActions = atLimit.blocks.find((block) => block.type === "actions");
    expect(JSON.stringify(atLimitActions)).not.toContain(SLACK_ACTION_IDS.edit);
    expect(JSON.stringify(atLimit.blocks)).toContain("edit limit has been reached");

    const unsupported: StoredProposal = {
      ...supportedProposal,
      evidence_status: "INSUFFICIENT_EVIDENCE",
      draft_reply: "",
      cited_policy_keys: [],
      policyEvidence: [],
    };
    const manual = buildReviewMessage({ ticketId: "7002", proposal: unsupported, evidence: [] });
    const manualActions = manual.blocks.find((block) => block.type === "actions");
    expect(JSON.stringify(manualActions)).not.toContain(SLACK_ACTION_IDS.approve);
    expect(JSON.stringify(manualActions)).toContain(SLACK_ACTION_IDS.reject);
  });

  it("posts once with Slack Web API and distinguishes known rejection from ambiguous outcome", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: true, channel: "C0C7X4Y182E", ts: "1791547200.000001" }),
    );
    const client = new SlackClient("xoxb-test-token", fetcher);
    await expect(
      client.postReviewMessage("C0C7X4Y182E", {
        ticketId: "7001",
        proposal: supportedProposal,
        evidence,
      }),
    ).resolves.toEqual({ channelId: "C0C7X4Y182E", messageTs: "1791547200.000001" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0];
    expect(String(call?.[0])).toBe("https://slack.com/api/chat.postMessage");
    expect(call?.[1]?.method).toBe("POST");
    expect(call?.[1]?.headers).toMatchObject({ authorization: "Bearer xoxb-test-token" });

    const knownRejectedFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: false, error: "channel_not_found" }),
    );
    const rejected = new SlackClient("xoxb-test-token", knownRejectedFetch);
    await expect(
      rejected.postReviewMessage("C0C7X4Y182E", {
        ticketId: "7001",
        proposal: supportedProposal,
        evidence,
      }),
    ).rejects.toMatchObject({ outcome: "rejected" } satisfies Partial<SlackApiError>);
    expect(knownRejectedFetch).toHaveBeenCalledTimes(1);

    const internalErrorFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: false, error: "internal_error" }),
    );
    const internalError = new SlackClient("xoxb-test-token", internalErrorFetch);
    await expect(
      internalError.postReviewMessage("C0C7X4Y182E", {
        ticketId: "7001",
        proposal: supportedProposal,
        evidence,
      }),
    ).rejects.toMatchObject({ outcome: "unknown" } satisfies Partial<SlackApiError>);
    expect(internalErrorFetch).toHaveBeenCalledTimes(1);

    const uncertainStatusFetch = vi.fn<typeof fetch>(async () => new Response("", { status: 409 }));
    const uncertainStatus = new SlackClient("xoxb-test-token", uncertainStatusFetch);
    await expect(
      uncertainStatus.postReviewMessage("C0C7X4Y182E", {
        ticketId: "7001",
        proposal: supportedProposal,
        evidence,
      }),
    ).rejects.toMatchObject({ outcome: "unknown" } satisfies Partial<SlackApiError>);
    expect(uncertainStatusFetch).toHaveBeenCalledTimes(1);

    const unknown = new SlackClient("xoxb-test-token", async () => {
      throw new Error("secret/network detail must not escape");
    });
    await expect(
      unknown.postReviewMessage("C0C7X4Y182E", {
        ticketId: "7001",
        proposal: supportedProposal,
        evidence,
      }),
    ).rejects.toMatchObject({ outcome: "unknown", message: "slack_post_outcome_unknown" });
  });
});
