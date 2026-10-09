import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { TicketProposal } from "../src/domain/contracts";
import { runScheduledTasks } from "../src/index";
import { TicketRepository } from "../src/state/ticket-repository";

const ticketId = "7650";
const at = new Date("2026-10-09T01:00:00.000Z");
const evidence = [
  {
    key: "billing-double-charge" as const,
    title: "Duplicate billing",
    url: "https://www.notion.so/demo-policy",
    contentHash: "a".repeat(64),
  },
];
const proposal: TicketProposal = {
  category: "BILLING",
  priority: "MEDIUM",
  evidence_status: "SUPPORTED",
  summary: "A duplicate subscription charge will be reviewed.",
  draft_reply: "We can review the dates and amounts.",
  cited_policy_keys: ["billing-double-charge"],
  rationale: "The policy allows billing review without card details.",
};

describe("Phase 3 scheduled outbox reconciliation", () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare("DELETE FROM events WHERE ticket_id = ?").bind(ticketId).run();
    await env.DB.prepare("DELETE FROM tickets WHERE hubspot_ticket_id = ?").bind(ticketId).run();
  });

  it("delivers a pending decision event before a failing HubSpot source poll", async () => {
    await env.DB.prepare(`INSERT INTO tickets (
        hubspot_ticket_id, workflow_instance_id, created_at, updated_at, hubspot_created_at,
        subject, state
      ) VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING')`)
      .bind(
        ticketId,
        `ticketpilot-test-${ticketId}`,
        at.toISOString(),
        at.toISOString(),
        at.toISOString(),
        `[TP-DEMO] Synthetic scheduled test ${ticketId}`,
      )
      .run();
    const repository = new TicketRepository(env.DB);
    expect(
      await repository.saveProposal(
        ticketId,
        proposal,
        "d".repeat(64),
        "ticketpilot-v1",
        evidence,
        at,
      ),
    ).toBe(true);
    expect(await repository.reserveSlackPost(ticketId, at)).toBe(true);
    expect(
      await repository.completeSlackPost(
        ticketId,
        "T0C7S09984V",
        "C0C7X4Y182E",
        "1791547200.000001",
        at,
      ),
    ).toBe(true);
    expect(
      await repository.recordSlackDecision({
        ticketId,
        proposalHash: "d".repeat(64),
        proposalRevision: 1,
        teamId: "T0C7S09984V",
        channelId: "C0C7X4Y182E",
        messageTs: "1791547200.000001",
        decision: "APPROVE",
        actorId: "U0C7X45H86N",
        now: at,
      }),
    ).toBe(true);
    await env.DB.prepare(
      "UPDATE tickets SET workflow_create_status = 'STARTED' WHERE hubspot_ticket_id = ?",
    )
      .bind(ticketId)
      .run();

    const order: string[] = [];
    const workflows = {
      async get() {
        return {
          async sendEvent() {
            order.push("decision-event");
          },
        };
      },
    };
    const scheduledEnv = {
      DB: env.DB,
      TICKETPILOT_ENV: "demo",
      TICKETPILOT_VERSION: "test",
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
      TICKET_WORKFLOW: workflows,
    } as unknown as Env;
    const source = {
      async searchDemoTickets(_cutoff: string) {
        order.push("hubspot-source");
        throw new Error("synthetic source outage");
      },
    };

    await runScheduledTasks(scheduledEnv, source);

    expect(order).toEqual(["decision-event", "hubspot-source"]);
    expect((await repository.getSlackReviewState(ticketId))?.decision_event_pending).toBe(0);
  });
});
