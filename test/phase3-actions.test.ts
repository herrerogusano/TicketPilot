import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SLACK_ACTION_IDS } from "../src/adapters/slack";
import type { TicketProposal } from "../src/domain/contracts";
import { routeRequest, type SlackRouteServices } from "../src/index";
import type { RuntimeConfigInput } from "../src/platform/config";
import { TicketRepository } from "../src/state/ticket-repository";
import { hashProposal } from "../src/workflows/ticket-workflow";

const configuredInput = {
  TICKETPILOT_ENV: "demo",
  TICKETPILOT_VERSION: "0.1.0",
  NOTION_PARENT_PAGE_ID: "3f3d34323f1a80b48e71c5860aeccc45",
  SLACK_CHANNEL_ID: "C0C7X4Y182E",
  SLACK_TEAM_ID: "T0C7S09984V",
  SLACK_APPROVER_USER_ID: "U0C7X45H86N",
  DEMO_START_AT: "2026-10-09T00:00:00Z",
  HUBSPOT_SERVICE_KEY: "pat-test1234567890",
  NOTION_TOKEN: "ntn_test123456789012345678901234567890",
  SLACK_BOT_TOKEN: "xoxb-test-12345678901234567890",
  SLACK_SIGNING_SECRET: "0123456789abcdef0123456789abcdef",
  RESEND_API_KEY: "re_test123456789012345678901234",
  TEST_RECIPIENT_EMAIL: "demo@example.test",
} satisfies RuntimeConfigInput;

let firstId = 7_300_000_000_000 + (Date.now() % 100_000_000);
let lastId = firstId + 99;
const baseDate = new Date();
const secret = configuredInput.SLACK_SIGNING_SECRET;

async function sign(rawBody: string, timestamp: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const result = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
  );
  return `v0=${Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function form(payload: unknown): string {
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

function payload(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "block_actions",
    team: { id: configuredInput.SLACK_TEAM_ID },
    user: { id: configuredInput.SLACK_APPROVER_USER_ID },
    channel: { id: configuredInput.SLACK_CHANNEL_ID },
    message: { ts: "1791547200.000001" },
    actions: [
      {
        action_id: SLACK_ACTION_IDS.approve,
        value: JSON.stringify({
          ticket_id: String(id),
          proposal_hash: String(id).padStart(64, "0").slice(-64),
          proposal_revision: 1,
        }),
      },
    ],
    ...overrides,
  };
}

function editClick(id: number, hash: string, revision: number): Record<string, unknown> {
  return payload(id, {
    trigger_id: "trigger-test-123",
    actions: [
      {
        action_id: SLACK_ACTION_IDS.edit,
        value: JSON.stringify({
          ticket_id: String(id),
          proposal_hash: hash,
          proposal_revision: revision,
        }),
      },
    ],
  });
}

function editSubmission(
  id: number,
  hash: string,
  revision: number,
  values: { draft: string; summary: string | null; reason: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "view_submission",
    team: { id: configuredInput.SLACK_TEAM_ID },
    user: { id: configuredInput.SLACK_APPROVER_USER_ID },
    view: {
      callback_id: "ticketpilot_edit_response",
      private_metadata: JSON.stringify({
        ticket_id: String(id),
        proposal_hash: hash,
        proposal_revision: revision,
        team_id: configuredInput.SLACK_TEAM_ID,
        channel_id: configuredInput.SLACK_CHANNEL_ID,
        message_ts: "1791547200.000001",
      }),
      state: {
        values: {
          draft_reply_block: { draft_reply: { type: "plain_text_input", value: values.draft } },
          summary_block: { summary: { type: "plain_text_input", value: values.summary } },
          reason_block: { reason: { type: "plain_text_input", value: values.reason } },
        },
      },
    },
    ...overrides,
  };
}

async function signedRequest(
  body: string,
  timestamp = String(Math.floor(Date.now() / 1_000)),
): Promise<Request> {
  return new Request("https://ticketpilot.example/slack/actions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": await sign(body, timestamp),
    },
    body,
  });
}

async function setupReview(id: number): Promise<TicketRepository> {
  const at = baseDate.toISOString();
  await env.DB.prepare(`INSERT INTO tickets (
      hubspot_ticket_id, workflow_instance_id, created_at, updated_at, hubspot_created_at,
      subject, state, category, priority, evidence_status, proposal_summary, draft_reply,
      policy_keys_json, proposal_rationale, policy_evidence_json, proposal_hash, prompt_version
    ) VALUES (?, ?, ?, ?, ?, ?, 'AWAITING_APPROVAL', 'BILLING', 'MEDIUM', 'SUPPORTED',
      'Duplicate charge review', 'We can review the charges.', '["billing-double-charge"]',
      'Policy permits billing review.', ?, ?, 'ticketpilot-v1')`)
    .bind(
      String(id),
      `ticketpilot-test-${id}`,
      at,
      at,
      at,
      `[TP-DEMO] Synthetic ${id}`,
      JSON.stringify([
        {
          key: "billing-double-charge",
          title: "Duplicate billing",
          url: "https://www.notion.so/policy",
          contentHash: "a".repeat(64),
        },
      ]),
      String(id).padStart(64, "0").slice(-64),
    )
    .run();
  await env.DB.prepare(`UPDATE tickets SET slack_post_status = 'POSTED', slack_post_attempts = 1,
      slack_team_id = ?, slack_channel = ?, slack_message_ts = ?, slack_review_started_at = ?,
      slack_review_deadline = ? WHERE hubspot_ticket_id = ?`)
    .bind(
      configuredInput.SLACK_TEAM_ID,
      configuredInput.SLACK_CHANNEL_ID,
      "1791547200.000001",
      at,
      new Date(baseDate.getTime() + 48 * 60 * 60 * 1_000).toISOString(),
      String(id),
    )
    .run();
  return new TicketRepository(env.DB);
}

function makeServices(
  sender: (input: { type: string; payload: unknown }) => Promise<void>,
): SlackRouteServices {
  return {
    DB: env.DB,
    TICKET_WORKFLOW: {
      async get() {
        return { sendEvent: sender };
      },
    },
  };
}

function makeContext(): { ctx: Pick<ExecutionContext, "waitUntil">; tasks: Promise<unknown>[] } {
  const tasks: Promise<unknown>[] = [];
  const ctx: Pick<ExecutionContext, "waitUntil"> = {
    waitUntil(promise) {
      tasks.push(promise);
    },
  };
  return { ctx, tasks };
}

describe("Phase 3 signed Slack callback route", () => {
  beforeEach(async () => {
    firstId += 1_000;
    lastId = firstId + 99;
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare("DELETE FROM events WHERE ticket_id BETWEEN ? AND ?")
      .bind(String(firstId), String(lastId))
      .run();
    await env.DB.prepare("DELETE FROM tickets WHERE hubspot_ticket_id BETWEEN ? AND ?")
      .bind(String(firstId), String(lastId))
      .run();
    vi.stubGlobal("fetch", async () => Response.json({ ok: true }));
  });

  it("acknowledges after the durable first-wins write without awaiting Workflow delivery", async () => {
    const repository = await setupReview(firstId);
    let release: (() => void) | undefined;
    const pendingSend = new Promise<void>((resolve) => {
      release = resolve;
    });
    const services = makeServices(() => pendingSend);
    const { ctx, tasks } = makeContext();
    const request = await signedRequest(form(payload(firstId)));
    const started = Date.now();
    const response = await routeRequest(request, configuredInput, services, ctx);
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(tasks).toHaveLength(1);
    expect((await repository.getSlackReviewState(String(firstId)))?.decision).toBe("APPROVE");
    release?.();
    await Promise.all(tasks);
  });

  it("rejects forged, stale, body-altered, or unauthorized team/channel/actor callbacks", async () => {
    const repository = await setupReview(firstId);
    const { ctx } = makeContext();
    const services = makeServices(async () => undefined);
    const raw = form(payload(firstId));
    const valid = await signedRequest(raw);
    const invalid = new Request(valid.url, {
      method: "POST",
      headers: new Headers(valid.headers),
      body: raw,
    });
    invalid.headers.set("x-slack-signature", "v0=bad");
    expect((await routeRequest(invalid, configuredInput, services, ctx)).status).toBe(401);
    const stale = await signedRequest(raw, String(Math.floor(Date.now() / 1_000) - 301));
    expect((await routeRequest(stale, configuredInput, services, ctx)).status).toBe(401);
    const altered = new Request(valid.url, {
      method: "POST",
      headers: valid.headers,
      body: `${raw}&tampered=1`,
    });
    expect((await routeRequest(altered, configuredInput, services, ctx)).status).toBe(401);

    for (const override of [
      { user: { id: "UOTHER" } },
      { team: { id: "TOTHER" } },
      { channel: { id: "COTHER" } },
    ]) {
      const request = await signedRequest(form(payload(firstId, override)));
      expect((await routeRequest(request, configuredInput, services, ctx)).status).toBe(403);
    }
    expect((await repository.getSlackReviewState(String(firstId)))?.decision).toBeNull();
  });

  it("makes wrong proposal hash, revision, or message timestamp a signed no-op", async () => {
    const repository = await setupReview(firstId);
    const services = makeServices(async () => undefined);
    const { ctx } = makeContext();
    const cases: Record<string, unknown>[] = [
      {
        actions: [
          {
            action_id: SLACK_ACTION_IDS.approve,
            value: JSON.stringify({
              ticket_id: String(firstId),
              proposal_hash: "f".repeat(64),
              proposal_revision: 1,
            }),
          },
        ],
      },
      {
        actions: [
          {
            action_id: SLACK_ACTION_IDS.approve,
            value: JSON.stringify({
              ticket_id: String(firstId),
              proposal_hash: String(firstId).padStart(64, "0").slice(-64),
              proposal_revision: 2,
            }),
          },
        ],
      },
      { message: { ts: "1791547201.000001" } },
    ];
    for (const override of cases) {
      const request = await signedRequest(form(payload(firstId, override)));
      expect((await routeRequest(request, configuredInput, services, ctx)).status).toBe(200);
    }
    expect((await repository.getSlackReviewState(String(firstId)))?.decision).toBeNull();
  });

  it("serializes a concurrent approve/reject double-click to one durable decision", async () => {
    const repository = await setupReview(firstId);
    const services = makeServices(async () => undefined);
    const { ctx, tasks } = makeContext();
    const approvePayload = payload(firstId);
    const rejectPayload = payload(firstId, {
      actions: [
        {
          action_id: SLACK_ACTION_IDS.reject,
          value: JSON.stringify({
            ticket_id: String(firstId),
            proposal_hash: String(firstId).padStart(64, "0").slice(-64),
            proposal_revision: 1,
          }),
        },
      ],
    });
    const [approve, reject] = await Promise.all([
      signedRequest(form(approvePayload)),
      signedRequest(form(rejectPayload)),
    ]);
    const responses = await Promise.all([
      routeRequest(approve, configuredInput, services, ctx),
      routeRequest(reject, configuredInput, services, ctx),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await Promise.all(tasks);
    const row = await repository.getSlackReviewState(String(firstId));
    expect(row?.decision).toMatch(/^(APPROVE|REJECT)$/);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE ticket_id = ? AND event_type IN ('SLACK_APPROVED','SLACK_REJECTED')",
    )
      .bind(String(firstId))
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("opens the allowlisted edit modal, saves two immutable revisions, then approves only the latest card", async () => {
    const repository = await setupReview(firstId);
    const slackCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://slack.com/api/")) {
        slackCalls.push({
          method: url.slice("https://slack.com/api/".length),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
      }
      return Response.json({
        ok: true,
        channel: configuredInput.SLACK_CHANNEL_ID,
        ts: "1791547200.000001",
      });
    });
    const services = makeServices(async () => undefined);
    const { ctx, tasks } = makeContext();
    let current = await repository.getProposal(String(firstId));
    expect(current).not.toBeNull();
    const open = await routeRequest(
      await signedRequest(form(editClick(firstId, current?.proposalHash ?? "", 1))),
      configuredInput,
      services,
      ctx,
    );
    expect(open.status).toBe(200);
    expect(slackCalls.at(-1)?.method).toBe("views.open");
    expect(JSON.stringify(slackCalls.at(-1)?.body)).toContain(
      "Internal reason and solution changes",
    );

    const firstDraft =
      "First revised solution: confirm the duplicate charge and review the billing dates.";
    const firstSubmit = await routeRequest(
      await signedRequest(
        form(
          editSubmission(firstId, current?.proposalHash ?? "", 1, {
            draft: firstDraft,
            summary: null,
            reason: "Clarified the billing review solution.",
          }),
        ),
      ),
      configuredInput,
      services,
      ctx,
    );
    expect(await firstSubmit.json()).toMatchObject({ response_action: "clear" });
    await Promise.all(tasks.splice(0));
    current = await repository.getProposal(String(firstId));
    expect(current).toMatchObject({
      revision: 2,
      draft_reply: firstDraft,
      summary: "Duplicate charge review",
    });
    const duplicateSubmit = await routeRequest(
      await signedRequest(
        form(
          editSubmission(firstId, String(firstId).padStart(64, "0").slice(-64), 1, {
            draft: firstDraft,
            summary: "",
            reason: "Clarified the billing review solution.",
          }),
        ),
      ),
      configuredInput,
      services,
      ctx,
    );
    expect(await duplicateSubmit.json()).toMatchObject({ response_action: "errors" });
    expect((await repository.getProposal(String(firstId)))?.revision).toBe(2);

    const firstHash = current?.proposalHash ?? "";
    const secondDraft =
      "Final revised solution: review both amounts and dates under the billing policy.";
    const secondSubmit = await routeRequest(
      await signedRequest(
        form(
          editSubmission(firstId, firstHash, 2, {
            draft: secondDraft,
            summary: "Review two charges",
            reason: "Updated the proposed resolution after checking the policy.",
          }),
        ),
      ),
      configuredInput,
      services,
      ctx,
    );
    expect(await secondSubmit.json()).toMatchObject({ response_action: "clear" });
    await Promise.all(tasks.splice(0));
    current = await repository.getProposal(String(firstId));
    expect(current).toMatchObject({
      revision: 3,
      draft_reply: secondDraft,
      summary: "Review two charges",
    });
    const history = await repository.getProposalRevisionHistory(String(firstId));
    expect(history).toHaveLength(3);
    expect(history.map((item) => item.proposal_hash)).toEqual([
      String(firstId).padStart(64, "0").slice(-64),
      expect.any(String),
      expect.any(String),
    ]);
    expect(history[1]).toMatchObject({
      edited_by: configuredInput.SLACK_APPROVER_USER_ID,
      edit_reason: "Clarified the billing review solution.",
    });
    expect(history[2]).toMatchObject({
      edited_by: configuredInput.SLACK_APPROVER_USER_ID,
      edit_reason: "Updated the proposed resolution after checking the policy.",
    });
    expect(slackCalls.filter((call) => call.method === "chat.update")).toHaveLength(2);
    expect(JSON.stringify(slackCalls.at(-1)?.body)).toContain("Revision: 3 (human edited)");
    expect(JSON.stringify(slackCalls.at(-1)?.body)).toContain(current?.proposalHash);

    const approved = await routeRequest(
      await signedRequest(
        form(
          payload(firstId, {
            actions: [
              {
                action_id: SLACK_ACTION_IDS.approve,
                value: JSON.stringify({
                  ticket_id: String(firstId),
                  proposal_hash: current?.proposalHash,
                  proposal_revision: 3,
                }),
              },
            ],
          }),
        ),
      ),
      configuredInput,
      services,
      ctx,
    );
    expect(approved.status).toBe(200);
    await Promise.all(tasks);
    expect(await repository.getSlackReviewState(String(firstId))).toMatchObject({
      decision: "APPROVE",
      proposal_revision: 3,
      proposal_hash: current?.proposalHash,
    });
  });

  it("rejects stale modal submissions, old-version approvals, empty or oversized edits, and edits after approval", async () => {
    const repository = await setupReview(firstId);
    const services = makeServices(async () => undefined);
    const { ctx, tasks } = makeContext();
    const original = await repository.getProposal(String(firstId));
    expect(original).not.toBeNull();
    const changed: TicketProposal = {
      category: "BILLING",
      priority: "MEDIUM",
      evidence_status: "SUPPORTED",
      summary: "Duplicate charge review",
      draft_reply: "A current human-edited response.",
      cited_policy_keys: ["billing-double-charge"],
      rationale: "Policy permits billing review.",
    };
    const hash = await hashProposal({
      ticketId: String(firstId),
      revision: 2,
      proposal: changed,
      evidence: original?.policyEvidence ?? [],
      promptVersion: original?.promptVersion ?? "ticketpilot-v1",
    });
    expect(
      await repository.editProposal({
        ticketId: String(firstId),
        expectedHash: original?.proposalHash ?? "",
        expectedRevision: 1,
        proposal: changed,
        proposalHash: hash,
        reason: "A solution clarification.",
        editorId: configuredInput.SLACK_APPROVER_USER_ID,
        teamId: configuredInput.SLACK_TEAM_ID,
        channelId: configuredInput.SLACK_CHANNEL_ID,
        messageTs: "1791547200.000001",
      }),
    ).toBe(true);
    const token = crypto.randomUUID();
    expect(await repository.reserveSlackRefresh(String(firstId), 2, token)).toBe(true);
    expect(await repository.completeSlackRefresh(String(firstId), 2, token)).toBe(true);
    const stale = await routeRequest(
      await signedRequest(
        form(
          editSubmission(firstId, original?.proposalHash ?? "", 1, {
            draft: "A stale modal response",
            summary: "",
            reason: "Old modal.",
          }),
        ),
      ),
      configuredInput,
      services,
      ctx,
    );
    expect(stale.status).toBe(200);
    expect(await stale.json()).toMatchObject({ response_action: "errors" });
    const staleApprove = await routeRequest(
      await signedRequest(form(payload(firstId))),
      configuredInput,
      services,
      ctx,
    );
    expect(staleApprove.status).toBe(200);
    expect((await repository.getSlackReviewState(String(firstId)))?.decision).toBeNull();

    const empty = await routeRequest(
      await signedRequest(
        form(
          editSubmission(firstId, hash, 2, {
            draft: "",
            summary: "",
            reason: "Missing response.",
          }),
        ),
      ),
      configuredInput,
      services,
      ctx,
    );
    expect(await empty.json()).toMatchObject({ response_action: "errors" });
    const oversized = await routeRequest(
      await signedRequest(
        form(
          editSubmission(firstId, hash, 2, {
            draft: "x".repeat(1501),
            summary: "",
            reason: "Too long.",
          }),
        ),
      ),
      configuredInput,
      services,
      ctx,
    );
    expect(await oversized.json()).toMatchObject({ response_action: "errors" });

    expect(
      await repository.recordSlackDecision({
        ticketId: String(firstId),
        proposalHash: hash,
        proposalRevision: 2,
        teamId: configuredInput.SLACK_TEAM_ID,
        channelId: configuredInput.SLACK_CHANNEL_ID,
        messageTs: "1791547200.000001",
        decision: "APPROVE",
        actorId: configuredInput.SLACK_APPROVER_USER_ID,
      }),
    ).toBe(true);
    const afterApproval = await routeRequest(
      await signedRequest(
        form(
          editSubmission(firstId, hash, 2, {
            draft: "Should not change after approval.",
            summary: "",
            reason: "Too late.",
          }),
        ),
      ),
      configuredInput,
      services,
      ctx,
    );
    expect(await afterApproval.json()).toMatchObject({ response_action: "errors" });
    expect((await repository.getProposal(String(firstId)))?.draft_reply).toBe(changed.draft_reply);
    await Promise.all(tasks);
  });

  it("keeps approval blocked when Slack card refresh fails, then cron retries the exact current revision", async () => {
    const repository = await setupReview(firstId);
    const original = await repository.getProposal(String(firstId));
    expect(original).not.toBeNull();
    let failUpdate = true;
    const updates: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/chat.update")) {
        updates.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (failUpdate) return Response.json({ ok: false, error: "internal_error" });
      }
      return Response.json({
        ok: true,
        channel: configuredInput.SLACK_CHANNEL_ID,
        ts: "1791547200.000001",
      });
    });
    const services = makeServices(async () => undefined);
    const { ctx, tasks } = makeContext();
    const failedSubmit = await routeRequest(
      await signedRequest(
        form(
          editSubmission(firstId, original?.proposalHash ?? "", 1, {
            draft: "Current response waiting for Slack refresh.",
            summary: "",
            reason: "Corrected the solution.",
          }),
        ),
      ),
      configuredInput,
      services,
      ctx,
    );
    expect(await failedSubmit.json()).toMatchObject({ response_action: "clear" });
    await Promise.all(tasks.splice(0));
    let state = await repository.getSlackReviewState(String(firstId));
    expect(state?.slack_refresh_revision).toBe(2);
    expect(
      await repository.recordSlackDecision({
        ticketId: String(firstId),
        proposalHash: state?.proposal_hash ?? "",
        proposalRevision: 2,
        teamId: configuredInput.SLACK_TEAM_ID,
        channelId: configuredInput.SLACK_CHANNEL_ID,
        messageTs: "1791547200.000001",
        decision: "APPROVE",
        actorId: configuredInput.SLACK_APPROVER_USER_ID,
      }),
    ).toBe(false);

    failUpdate = false;
    await env.DB.prepare(
      "UPDATE tickets SET slack_refresh_locked_until = ? WHERE hubspot_ticket_id = ?",
    )
      .bind(new Date(Date.now() - 1_000).toISOString(), String(firstId))
      .run();
    const { reconcilePendingSlackRefresh } = await import("../src/index");
    await reconcilePendingSlackRefresh(env);
    state = await repository.getSlackReviewState(String(firstId));
    expect(state?.slack_refresh_revision).toBeNull();
    expect(updates).toHaveLength(2);
    expect(JSON.stringify(updates[1])).toContain("Current response waiting for Slack refresh.");
    expect((await repository.getProposal(String(firstId)))?.revision).toBe(2);
  });

  it("serializes a concurrent human edit and approval so only one current revision wins", async () => {
    const repository = await setupReview(firstId);
    const original = await repository.getProposal(String(firstId));
    expect(original).not.toBeNull();
    const proposal = {
      category: "BILLING" as const,
      priority: "MEDIUM" as const,
      evidence_status: "SUPPORTED" as const,
      summary: "Updated review",
      draft_reply: "Updated but not approved response.",
      cited_policy_keys: ["billing-double-charge" as const],
      rationale: "Policy permits billing review.",
    };
    const hash = await hashProposal({
      ticketId: String(firstId),
      revision: 2,
      proposal,
      evidence: original?.policyEvidence ?? [],
      promptVersion: original?.promptVersion ?? "ticketpilot-v1",
    });
    const outcomes = await Promise.all([
      repository.editProposal({
        ticketId: String(firstId),
        expectedHash: original?.proposalHash ?? "",
        expectedRevision: 1,
        proposal,
        proposalHash: hash,
        reason: "Solution update.",
        editorId: configuredInput.SLACK_APPROVER_USER_ID,
        teamId: configuredInput.SLACK_TEAM_ID,
        channelId: configuredInput.SLACK_CHANNEL_ID,
        messageTs: "1791547200.000001",
      }),
      repository.recordSlackDecision({
        ticketId: String(firstId),
        proposalHash: original?.proposalHash ?? "",
        proposalRevision: 1,
        teamId: configuredInput.SLACK_TEAM_ID,
        channelId: configuredInput.SLACK_CHANNEL_ID,
        messageTs: "1791547200.000001",
        decision: "APPROVE",
        actorId: configuredInput.SLACK_APPROVER_USER_ID,
      }),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const state = await repository.getSlackReviewState(String(firstId));
    if (outcomes[0])
      expect(state).toMatchObject({
        decision: null,
        proposal_revision: 2,
        slack_refresh_revision: 2,
      });
    else expect(state).toMatchObject({ decision: "APPROVE", proposal_revision: 1 });
  });

  it("does not open edits for expired, wrong-user, wrong-team, wrong-channel, or wrong-message callbacks", async () => {
    const repository = await setupReview(firstId);
    const proposal = await repository.getProposal(String(firstId));
    expect(proposal).not.toBeNull();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({ ok: true });
    });
    const services = makeServices(async () => undefined);
    const { ctx } = makeContext();
    const cases: Array<{ override: Record<string, unknown>; status: number }> = [
      { override: { user: { id: "UOTHER" } }, status: 403 },
      { override: { team: { id: "TOTHER" } }, status: 403 },
      { override: { channel: { id: "COTHER" } }, status: 403 },
      { override: { message: { ts: "1791547201.000001" } }, status: 200 },
    ];
    for (const { override, status } of cases) {
      const response = await routeRequest(
        await signedRequest(
          form({
            ...editClick(firstId, proposal?.proposalHash ?? "", 1),
            ...override,
          }),
        ),
        configuredInput,
        services,
        ctx,
      );
      expect(response.status).toBe(status);
    }
    expect(calls).toHaveLength(0);
    await env.DB.prepare("UPDATE tickets SET slack_review_deadline = ? WHERE hubspot_ticket_id = ?")
      .bind(new Date(Date.now() - 1_000).toISOString(), String(firstId))
      .run();
    const expired = await routeRequest(
      await signedRequest(form(editClick(firstId, proposal?.proposalHash ?? "", 1))),
      configuredInput,
      services,
      ctx,
    );
    expect(expired.status).toBe(200);
    expect(calls).toHaveLength(0);
    expect((await repository.getProposal(String(firstId)))?.revision).toBe(1);
  });
});
