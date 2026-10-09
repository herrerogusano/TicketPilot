import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type PolicyEvidence,
  type TicketProposal,
  unsupportedProposal,
} from "../src/domain/contracts";
import {
  dispatchDecisionEvent,
  reconcilePendingDecisionEvents,
} from "../src/state/decision-events";
import { TicketRepository } from "../src/state/ticket-repository";

const firstId = 7_100;
const lastId = 7_199;
const evidence: PolicyEvidence[] = [
  {
    key: "billing-double-charge",
    title: "[TP-KB:billing-double-charge] Duplicate billing",
    url: "https://www.notion.so/demo-policy",
    contentHash: "a".repeat(64),
  },
];
const supported: TicketProposal = {
  category: "BILLING",
  priority: "MEDIUM",
  evidence_status: "SUPPORTED",
  summary: "The duplicate charge will be reviewed.",
  draft_reply: "We can review the dates and amounts.",
  cited_policy_keys: ["billing-double-charge"],
  rationale: "The policy allows billing review without card data.",
};
const now = new Date();

async function setupTicket(
  id: number,
  proposal: TicketProposal = supported,
): Promise<TicketRepository> {
  const at = now.toISOString();
  await env.DB.prepare(`INSERT INTO tickets (
      hubspot_ticket_id, workflow_instance_id, created_at, updated_at, hubspot_created_at,
      subject, state
    ) VALUES (?, ?, ?, ?, ?, ?, 'PROCESSING')`)
    .bind(String(id), `ticketpilot-test-${id}`, at, at, at, `[TP-DEMO] Synthetic ${id}`)
    .run();
  const repository = new TicketRepository(env.DB);
  const hash = String(id).padStart(64, "0").slice(-64);
  const actualEvidence = proposal.evidence_status === "SUPPORTED" ? evidence : [];
  await repository.saveProposal(String(id), proposal, hash, "ticketpilot-v1", actualEvidence, now);
  return repository;
}

async function postReview(repository: TicketRepository, id: number): Promise<void> {
  expect(await repository.reserveSlackPost(String(id), now)).toBe(true);
  expect(
    await repository.completeSlackPost(
      String(id),
      "T0C7S09984V",
      "C0C7X4Y182E",
      "1791547200.000001",
      now,
    ),
  ).toBe(true);
}

function decisionInput(
  id: number,
  decision: "APPROVE" | "REJECT",
  override: Partial<Parameters<TicketRepository["recordSlackDecision"]>[0]> = {},
  at = now,
): Parameters<TicketRepository["recordSlackDecision"]>[0] {
  return {
    ticketId: String(id),
    proposalHash: String(id).padStart(64, "0").slice(-64),
    proposalRevision: 1,
    teamId: "T0C7S09984V",
    channelId: "C0C7X4Y182E",
    messageTs: "1791547200.000001",
    decision,
    actorId: "U0C7X45H86N",
    now: at,
    ...override,
  };
}

describe("Phase 3 D1 Slack publication and first-wins decisions", () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare("DELETE FROM events WHERE ticket_id BETWEEN ? AND ?")
      .bind(String(firstId), String(lastId))
      .run();
    await env.DB.prepare("DELETE FROM tickets WHERE hubspot_ticket_id BETWEEN ? AND ?")
      .bind(String(firstId), String(lastId))
      .run();
  });

  it("reserves at most one Slack message and persists its exact target and 48-hour deadline", async () => {
    const repository = await setupTicket(firstId);
    expect(await repository.reserveSlackPost(String(firstId), now)).toBe(true);
    expect(await repository.reserveSlackPost(String(firstId), now)).toBe(false);
    expect(
      await repository.completeSlackPost(
        String(firstId),
        "T0C7S09984V",
        "C0C7X4Y182E",
        "1791547200.000001",
        now,
      ),
    ).toBe(true);
    const row = await repository.getSlackReviewState(String(firstId));
    expect(row).toMatchObject({
      slack_post_status: "POSTED",
      slack_team_id: "T0C7S09984V",
      slack_channel: "C0C7X4Y182E",
      slack_message_ts: "1791547200.000001",
      slack_review_started_at: now.toISOString(),
      slack_review_deadline: new Date(now.getTime() + 48 * 60 * 60 * 1_000).toISOString(),
    });
  });

  it("marks only lease-expired Slack reservations unknown", async () => {
    const repository = await setupTicket(firstId);
    expect(await repository.reserveSlackPost(String(firstId), now)).toBe(true);
    const stillActiveAt = new Date(now.getTime() + 29_999);
    expect(
      await repository.failStaleSlackPost(
        String(firstId),
        new Date(stillActiveAt.getTime() - 30_000),
        stillActiveAt,
      ),
    ).toBe(false);
    expect((await repository.getSlackReviewState(String(firstId)))?.slack_post_status).toBe(
      "IN_PROGRESS",
    );
    const expiredAt = new Date(now.getTime() + 30_000);
    expect(
      await repository.failStaleSlackPost(
        String(firstId),
        new Date(expiredAt.getTime() - 30_000),
        expiredAt,
      ),
    ).toBe(true);
    expect((await repository.getSlackReviewState(String(firstId)))?.slack_post_status).toBe(
      "UNKNOWN",
    );
  });

  it("makes a supported first decision atomically and blocks duplicate clicks", async () => {
    const repository = await setupTicket(firstId);
    await postReview(repository, firstId);
    const results = await Promise.all([
      repository.recordSlackDecision(decisionInput(firstId, "APPROVE")),
      repository.recordSlackDecision(decisionInput(firstId, "REJECT")),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await repository.getSlackReviewState(String(firstId));
    expect(row?.decision).toMatch(/^(APPROVE|REJECT)$/);
    expect(row?.state).toBe(row?.decision === "APPROVE" ? "APPROVED" : "REJECTED");
    expect(row?.decision_event_pending).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE ticket_id = ? AND event_type IN ('SLACK_APPROVED','SLACK_REJECTED')",
      )
        .bind(String(firstId))
        .first<{ count: number }>(),
    ).toMatchObject({ count: 1 });
    expect(await repository.recordSlackDecision(decisionInput(firstId, "APPROVE"))).toBe(false);
  });

  it("rejects wrong ticket hash, revision, team, channel, message timestamp, or expired deadline", async () => {
    const repository = await setupTicket(firstId);
    await postReview(repository, firstId);
    const cases: Partial<Parameters<TicketRepository["recordSlackDecision"]>[0]>[] = [
      { proposalHash: "f".repeat(64) },
      { proposalRevision: 2 },
      { teamId: "TOTHER" },
      { channelId: "COTHER" },
      { messageTs: "1791547201.000001" },
    ];
    for (const override of cases) {
      expect(
        await repository.recordSlackDecision(decisionInput(firstId, "APPROVE", override)),
      ).toBe(false);
    }
    const late = new Date(now.getTime() + 48 * 60 * 60 * 1_000 + 1);
    expect(await repository.recordSlackDecision(decisionInput(firstId, "APPROVE", {}, late))).toBe(
      false,
    );
    expect(await repository.expireSlackReview(String(firstId), late)).toBe(true);
    expect((await repository.getSlackReviewState(String(firstId)))?.state).toBe("EXPIRED");
  });

  it("fails closed for insufficient evidence and independently enforces the D1 approval invariant", async () => {
    const repository = await setupTicket(firstId, unsupportedProposal());
    await postReview(repository, firstId);
    expect(await repository.recordSlackDecision(decisionInput(firstId, "APPROVE"))).toBe(false);
    expect(await repository.recordSlackDecision(decisionInput(firstId, "REJECT"))).toBe(true);
    const secondId = firstId + 1;
    await setupTicket(secondId, unsupportedProposal());
    await expect(
      env.DB.prepare(
        "UPDATE tickets SET decision = 'APPROVE', decision_by = ?, decision_at = ?, state = 'APPROVED' WHERE hubspot_ticket_id = ?",
      )
        .bind("U0C7X45H86N", now.toISOString(), String(secondId))
        .run(),
    ).rejects.toThrow("approval requires supported grounded proposal");
  });

  it("reconciles event-send failure without losing the decision, then marks delivered on retry", async () => {
    const repository = await setupTicket(firstId);
    await postReview(repository, firstId);
    expect(await repository.recordSlackDecision(decisionInput(firstId, "APPROVE"))).toBe(true);
    let attempts = 0;
    const delivered: unknown[] = [];
    const workflows = {
      async get(instanceId: string) {
        expect(instanceId).toBe(`ticketpilot-test-${firstId}`);
        return {
          async sendEvent(event: { type: string; payload: unknown }) {
            attempts += 1;
            if (attempts < 3) throw new Error("transient runtime detail");
            delivered.push(event);
          },
        };
      },
    };
    expect(await dispatchDecisionEvent(String(firstId), repository, workflows)).toBe(
      "retry_pending",
    );
    expect((await repository.getSlackReviewState(String(firstId)))?.decision_event_pending).toBe(1);
    expect(await reconcilePendingDecisionEvents(repository, workflows, 1)).toEqual({
      examined: 1,
      delivered: 0,
      deferred: 1,
    });
    expect(await reconcilePendingDecisionEvents(repository, workflows, 1)).toEqual({
      examined: 1,
      delivered: 1,
      deferred: 0,
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      type: "ticket-decision",
      payload: {
        ticketId: String(firstId),
        decision: "APPROVE",
        actorId: "U0C7X45H86N",
        proposalRevision: 1,
      },
    });
    expect((await repository.getSlackReviewState(String(firstId)))?.decision_event_pending).toBe(0);
  });

  it("bounds event delivery to three attempts and retains the pending marker for manual recovery", async () => {
    const repository = await setupTicket(firstId);
    await postReview(repository, firstId);
    expect(await repository.recordSlackDecision(decisionInput(firstId, "APPROVE"))).toBe(true);
    const failing = {
      async get() {
        throw new Error("workflow unavailable");
      },
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await dispatchDecisionEvent(String(firstId), repository, failing)).toBe(
        "retry_pending",
      );
    }
    expect(await dispatchDecisionEvent(String(firstId), repository, failing)).toBe("not_pending");
    expect((await repository.getSlackReviewState(String(firstId)))?.decision_event_pending).toBe(1);
    const event = await env.DB.prepare(
      "SELECT event_type FROM events WHERE ticket_id = ? AND event_type = 'DECISION_EVENT_DELIVERY_EXHAUSTED'",
    )
      .bind(String(firstId))
      .first<{ event_type: string }>();
    expect(event?.event_type).toBe("DECISION_EVENT_DELIVERY_EXHAUSTED");
  });
});
