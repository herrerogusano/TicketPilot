import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SLACK_ACTION_IDS } from "../src/adapters/slack";
import { routeRequest, type SlackRouteServices } from "../src/index";
import type { RuntimeConfigInput } from "../src/platform/config";
import { TicketRepository } from "../src/state/ticket-repository";

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

const firstId = 7_300;
const lastId = 7_399;
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
});
