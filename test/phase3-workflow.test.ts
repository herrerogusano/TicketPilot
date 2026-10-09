import { applyD1Migrations, env, introspectWorkflowInstance } from "cloudflare:test";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredProposal } from "../src/domain/contracts";
import { TICKET_DECISION_EVENT_TYPE } from "../src/state/decision-events";
import { TicketRepository } from "../src/state/ticket-repository";
import { TicketWorkflow, type TicketWorkflowParams } from "../src/workflows/ticket-workflow";

const firstId = 7_500;
const lastId = 7_599;
const baseDate = new Date();
const channel = "C0C7X4Y182E";
const team = "T0C7S09984V";
const actor = "U0C7X45H86N";
const supportedProposal: StoredProposal = {
  category: "BILLING",
  priority: "MEDIUM",
  evidence_status: "SUPPORTED",
  summary: "Review the duplicate charge.",
  draft_reply: "We can review the two charges under the billing policy.",
  cited_policy_keys: ["billing-double-charge"],
  rationale: "The cited policy permits a billing review.",
  proposalHash: "a".repeat(64),
  revision: 1,
  promptVersion: "ticketpilot-v1",
  policyEvidence: [
    {
      key: "billing-double-charge",
      title: "Duplicate billing",
      url: "https://www.notion.so/policy",
      contentHash: "b".repeat(64),
    },
  ],
};
const unsupportedProposal: StoredProposal = {
  category: "OTHER",
  priority: "LOW",
  evidence_status: "INSUFFICIENT_EVIDENCE",
  summary: "Manual review is needed.",
  draft_reply: "",
  cited_policy_keys: [],
  rationale: "No applicable policy evidence was found.",
  proposalHash: "c".repeat(64),
  revision: 1,
  promptVersion: "ticketpilot-no-model-v1",
  policyEvidence: [],
};

async function insertProposal(id: number, proposal = supportedProposal): Promise<void> {
  const at = baseDate.toISOString();
  await env.DB.prepare(`INSERT INTO tickets (
      hubspot_ticket_id, workflow_instance_id, created_at, updated_at, hubspot_created_at,
      subject, state, category, priority, evidence_status, proposal_summary, draft_reply,
      policy_keys_json, proposal_rationale, policy_evidence_json, proposal_hash,
      proposal_revision, prompt_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      String(id),
      `ticketpilot-${id}`,
      at,
      at,
      at,
      `[TP-DEMO] Synthetic workflow ${id}`,
      proposal.evidence_status === "SUPPORTED" ? "AWAITING_APPROVAL" : "NEEDS_MANUAL_REVIEW",
      proposal.category,
      proposal.priority,
      proposal.evidence_status,
      proposal.summary,
      proposal.draft_reply,
      JSON.stringify(proposal.cited_policy_keys),
      proposal.rationale,
      JSON.stringify(proposal.policyEvidence),
      proposal.proposalHash,
      proposal.revision,
      proposal.promptVersion,
    )
    .run();
}

async function markPosted(id: number): Promise<void> {
  const at = baseDate.toISOString();
  await env.DB.prepare(`UPDATE tickets SET slack_post_status = 'POSTED', slack_post_attempts = 1,
      slack_team_id = ?, slack_channel = ?, slack_message_ts = ?, slack_review_started_at = ?,
      slack_review_deadline = ? WHERE hubspot_ticket_id = ?`)
    .bind(
      team,
      channel,
      "1791547200.000001",
      at,
      new Date(baseDate.getTime() + 48 * 60 * 60 * 1_000).toISOString(),
      String(id),
    )
    .run();
}

async function startWorkflow(id: number, label: string, eventPayload?: unknown) {
  const instanceId = `${label}-${id}-${crypto.randomUUID()}`;
  const inspector = await introspectWorkflowInstance(env.TICKET_WORKFLOW, instanceId);
  if (eventPayload !== undefined) {
    await inspector.modify(async (modifier) => {
      await modifier.mockEvent({ type: TICKET_DECISION_EVENT_TYPE, payload: eventPayload });
    });
  }
  await env.TICKET_WORKFLOW.create({ id: instanceId, params: { ticketId: String(id) } });
  return inspector;
}

describe("Phase 3 TicketWorkflow runtime", () => {
  beforeEach(async () => {
    Object.defineProperty(env, "TEST_RECIPIENT_EMAIL", {
      value: "ticketpilot-owner@example.test",
      configurable: true,
    });
    Object.defineProperty(env, "RESEND_API_KEY", {
      value: `re_${"x".repeat(24)}`,
      configurable: true,
    });
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare("DELETE FROM events WHERE ticket_id BETWEEN ? AND ?")
      .bind(String(firstId), String(lastId))
      .run();
    await env.DB.prepare("DELETE FROM tickets WHERE hubspot_ticket_id BETWEEN ? AND ?")
      .bind(String(firstId), String(lastId))
      .run();
  });

  it("resumes a cached Phase 2 proposal and posts exactly one approval message", async () => {
    await insertProposal(firstId);
    const posts: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push(body);
      return Response.json({ ok: true, channel, ts: "1791547200.000001" });
    });

    const inspector = await startWorkflow(firstId, "phase3-cached-proposal", {
      ticketId: String(firstId),
      decision: "APPROVE",
      actorId: actor,
      decidedAt: baseDate.toISOString(),
      proposalHash: supportedProposal.proposalHash,
      proposalRevision: supportedProposal.revision,
    });
    try {
      await inspector.waitForStatus("complete");
      expect(await inspector.getOutput()).toMatchObject({ status: "manual_review" });
      const state = await new TicketRepository(env.DB).getSlackReviewState(String(firstId));
      expect(state?.slack_post_status).toBe("POSTED");
      expect(state?.slack_review_deadline).not.toBeNull();
      expect(posts).toHaveLength(1);
      expect(posts[0]?.channel).toBe(channel);
      const blocks = posts[0]?.blocks as Array<{ elements?: Array<{ action_id?: string }> }>;
      expect(JSON.stringify(blocks)).toContain("ticketpilot_approve");
      expect(JSON.stringify(blocks)).toContain("This authorizes sending a real demo email");
    } finally {
      await inspector.dispose();
    }
  });

  it("never retries an ambiguous Slack post after a lost response", async () => {
    await insertProposal(firstId);
    let postCount = 0;
    vi.stubGlobal("fetch", async () => {
      postCount += 1;
      return new Response("temporarily unavailable", { status: 500 });
    });
    const first = await startWorkflow(firstId, "phase3-lost-post-response");
    try {
      await first.waitForStatus("complete");
      expect(await first.getOutput()).toMatchObject({ status: "manual_review" });
      expect(
        (await new TicketRepository(env.DB).getSlackReviewState(String(firstId)))
          ?.slack_post_status,
      ).toBe("UNKNOWN");
    } finally {
      await first.dispose();
    }

    const second = await startWorkflow(firstId, "phase3-runtime-replay");
    try {
      await second.waitForStatus("complete");
      expect(await second.getOutput()).toMatchObject({ status: "manual_review" });
      expect(postCount).toBe(1);
    } finally {
      await second.dispose();
    }
  });

  it("preserves an active post owner's lease when a duplicate Workflow overlaps", async () => {
    await insertProposal(firstId);
    let postCount = 0;
    let releasePost: ((response: Response) => void) | undefined;
    vi.stubGlobal("fetch", async () => {
      postCount += 1;
      return new Promise<Response>((resolve) => {
        releasePost = resolve;
      });
    });
    const workflow = Object.create(TicketWorkflow.prototype) as TicketWorkflow;
    Object.defineProperty(workflow, "env", { value: env });
    const event = { payload: { ticketId: String(firstId) } } as WorkflowEvent<TicketWorkflowParams>;
    const controlledStep = {
      async do<T>(_name: string, _options: unknown, callback: () => Promise<T> | T): Promise<T> {
        return await callback();
      },
      async waitForEvent() {
        return { payload: null };
      },
    } as unknown as WorkflowStep;
    const ownerPromise = workflow.run(event, controlledStep);
    try {
      const repository = new TicketRepository(env.DB);
      let activeReservation = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        activeReservation =
          (await repository.getSlackReviewState(String(firstId)))?.slack_post_status ===
          "IN_PROGRESS";
        if (activeReservation) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(activeReservation).toBe(true);
      const duplicate = await workflow.run(event, controlledStep);
      expect(duplicate).toMatchObject({ status: "manual_review" });
      expect(postCount).toBe(1);
      expect(
        (await new TicketRepository(env.DB).getSlackReviewState(String(firstId)))
          ?.slack_post_status,
      ).toBe("IN_PROGRESS");
      releasePost?.(Response.json({ ok: true, channel, ts: "1791547200.000001" }));
      expect(await ownerPromise).toMatchObject({ status: "manual_review" });
      expect(postCount).toBe(1);
      expect(
        (await new TicketRepository(env.DB).getSlackReviewState(String(firstId)))
          ?.slack_post_status,
      ).toBe("POSTED");
    } finally {
      releasePost?.(new Response("cleanup", { status: 500 }));
      await ownerPromise.catch(() => undefined);
    }
  });

  it("shows no Approve action for unsupported evidence and ignores an early mismatched event", async () => {
    await insertProposal(firstId, unsupportedProposal);
    let messageBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      messageBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ ok: true, channel, ts: "1791547200.000001" });
    });
    const inspector = await startWorkflow(firstId, "phase3-unsupported-proposal", {
      ticketId: String(firstId),
      decision: "APPROVE",
      actorId: actor,
      decidedAt: baseDate.toISOString(),
      proposalHash: unsupportedProposal.proposalHash,
      proposalRevision: unsupportedProposal.revision,
    });
    try {
      await inspector.waitForStatus("complete");
      expect(await inspector.getOutput()).toMatchObject({ status: "manual_review" });
      expect(JSON.stringify(messageBody?.blocks)).not.toContain("ticketpilot_approve");
      expect(
        (await new TicketRepository(env.DB).getSlackReviewState(String(firstId)))?.decision,
      ).toBeNull();
    } finally {
      await inspector.dispose();
    }
  });

  it("fails closed on malformed Workflow event data", async () => {
    await insertProposal(firstId);
    vi.stubGlobal("fetch", async () =>
      Response.json({ ok: true, channel, ts: "1791547200.000001" }),
    );
    const inspector = await startWorkflow(firstId, "phase3-malformed-event", null);
    try {
      await inspector.waitForStatus("complete");
      expect(await inspector.getOutput()).toMatchObject({ status: "manual_review" });
      expect(
        (await new TicketRepository(env.DB).getSlackReviewState(String(firstId)))?.decision,
      ).toBeNull();
    } finally {
      await inspector.dispose();
    }
  });

  it("does not authorize from an early event for a different ticket", async () => {
    await insertProposal(firstId);
    vi.stubGlobal("fetch", async () =>
      Response.json({ ok: true, channel, ts: "1791547200.000001" }),
    );
    const inspector = await startWorkflow(firstId, "phase3-mismatched-event", {
      ticketId: String(firstId + 1),
      decision: "APPROVE",
      actorId: actor,
      decidedAt: baseDate.toISOString(),
      proposalHash: supportedProposal.proposalHash,
      proposalRevision: supportedProposal.revision,
    });
    try {
      await inspector.waitForStatus("complete");
      expect(await inspector.getOutput()).toMatchObject({ status: "manual_review" });
      expect(
        (await new TicketRepository(env.DB).getSlackReviewState(String(firstId)))?.decision,
      ).toBeNull();
    } finally {
      await inspector.dispose();
    }
  });

  it("rejects an early durable decision from outside the approver allowlist", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    const repository = new TicketRepository(env.DB);
    const forged = await repository.recordSlackDecision({
      ticketId: String(firstId),
      proposalHash: supportedProposal.proposalHash,
      proposalRevision: supportedProposal.revision,
      teamId: team,
      channelId: channel,
      messageTs: "1791547200.000001",
      decision: "APPROVE",
      actorId: "U_NOT_ALLOWLISTED",
    });
    expect(forged).toBe(true);
    const inspector = await startWorkflow(firstId, "phase3-forged-decision");
    try {
      await inspector.waitForStatus("complete");
      expect(await inspector.getOutput()).toMatchObject({ status: "manual_review" });
    } finally {
      await inspector.dispose();
    }
  });

  it("accepts the durable first-wins decision when timeout races its Workflow event", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    const repository = new TicketRepository(env.DB);
    const won = await repository.recordSlackDecision({
      ticketId: String(firstId),
      proposalHash: supportedProposal.proposalHash,
      proposalRevision: supportedProposal.revision,
      teamId: team,
      channelId: channel,
      messageTs: "1791547200.000001",
      decision: "APPROVE",
      actorId: actor,
    });
    expect(won).toBe(true);
    const cachedBeforeDecision = await repository.getSlackReviewState(String(firstId));
    if (cachedBeforeDecision === null) throw new Error("missing_review_fixture");
    const instanceId = `phase3-timeout-race-${firstId}-${crypto.randomUUID()}`;
    const inspector = await introspectWorkflowInstance(env.TICKET_WORKFLOW, instanceId);
    await inspector.modify(async (modifier) => {
      await modifier.mockStepResult(
        { name: "phase3-load-slack-review" },
        {
          ...cachedBeforeDecision,
          state: "AWAITING_APPROVAL",
          decision: null,
          decision_by: null,
          decision_at: null,
        },
      );
      await modifier.forceEventTimeout({ name: "phase3-wait-for-human-decision" });
    });
    try {
      await env.TICKET_WORKFLOW.create({
        id: instanceId,
        params: { ticketId: String(firstId) },
      });
      await inspector.waitForStatus("complete");
      expect(await inspector.getOutput()).toMatchObject({ status: "send_unknown" });
      expect((await repository.getSlackReviewState(String(firstId)))?.decision).toBe("APPROVE");
    } finally {
      await inspector.dispose();
    }
  });
});
