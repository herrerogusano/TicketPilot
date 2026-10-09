import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildImmutableEmailPayload, hashEmailPayload } from "../src/adapters/resend";
import type { StoredProposal } from "../src/domain/contracts";
import { runScheduledTasks } from "../src/index";
import { EmailDeliveryRepository, maskRecipient } from "../src/state/email-delivery";

let ticketId = String(9_850_000_000_000 + (Date.now() % 100_000_000));
const recipient = "ticketpilot-owner@example.test";
const team = "T0C7S09984V";
const channel = "C0C7X4Y182E";
const actor = "U0C7X45H86N";
const proposal: StoredProposal = {
  category: "BILLING",
  priority: "MEDIUM",
  evidence_status: "SUPPORTED",
  summary: "Review a duplicate charge.",
  draft_reply: "We can review the charge under the policy.",
  cited_policy_keys: ["billing-double-charge"],
  rationale: "The billing policy covers this issue.",
  proposalHash: "d".repeat(64),
  revision: 1,
  promptVersion: "ticketpilot-v1",
  policyEvidence: [
    {
      key: "billing-double-charge",
      title: "Billing policy",
      url: "https://www.notion.so/policy",
      contentHash: "e".repeat(64),
    },
  ],
};

describe("Phase 4 scheduled audit recovery", () => {
  beforeEach(async () => {
    ticketId = String(Number(ticketId) + 1_000);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare("DELETE FROM events WHERE ticket_id = ?").bind(ticketId).run();
    await env.DB.prepare("DELETE FROM tickets WHERE hubspot_ticket_id = ?").bind(ticketId).run();
  });

  it("reconciles pending audit before a failing source poll and performs no email send", async () => {
    const at = new Date();
    await env.DB.prepare(`INSERT INTO tickets (
        hubspot_ticket_id, workflow_instance_id, created_at, updated_at, hubspot_created_at,
        subject, state, category, priority, evidence_status, proposal_summary, draft_reply,
        policy_keys_json, proposal_rationale, policy_evidence_json, proposal_hash,
        proposal_revision, prompt_version, decision, decision_by, decision_at,
        slack_team_id, slack_channel, slack_message_ts, slack_post_status, slack_review_deadline
      ) VALUES (?, ?, ?, ?, ?, ?, 'APPROVED', ?, ?, 'SUPPORTED', ?, ?, ?, ?, ?, ?, 1, ?,
        'APPROVE', ?, ?, ?, ?, ?, 'POSTED', ?)`)
      .bind(
        ticketId,
        `ticketpilot-${ticketId}`,
        at.toISOString(),
        at.toISOString(),
        at.toISOString(),
        `[TP-DEMO] ${ticketId}`,
        proposal.category,
        proposal.priority,
        proposal.summary,
        proposal.draft_reply,
        JSON.stringify(proposal.cited_policy_keys),
        proposal.rationale,
        JSON.stringify(proposal.policyEvidence),
        proposal.proposalHash,
        proposal.promptVersion,
        actor,
        at.toISOString(),
        team,
        channel,
        "1791547200.000001",
        new Date(at.getTime() + 48 * 60 * 60 * 1_000).toISOString(),
      )
      .run();
    await env.DB.prepare(
      "UPDATE tickets SET workflow_create_status = 'STARTED' WHERE hubspot_ticket_id = ?",
    )
      .bind(ticketId)
      .run();
    const payload = buildImmutableEmailPayload(ticketId, proposal, recipient);
    const hash = await hashEmailPayload(payload);
    const repository = new EmailDeliveryRepository(env.DB);
    expect(
      await repository.reserveApprovedEmail(
        ticketId,
        {
          proposalHash: proposal.proposalHash,
          proposalRevision: proposal.revision,
          approverId: actor,
          teamId: team,
          channelId: channel,
        },
        {
          payloadJson: JSON.stringify(payload),
          payloadHash: hash,
          idempotencyKey: `ticketpilot/${ticketId}/v1`,
          recipientAlias: maskRecipient(recipient),
        },
        at,
      ),
    ).toBe(true);
    expect(await repository.recordAccepted(ticketId, 1, "resend-accepted", at)).toBe(true);
    const delivery = await repository.get(ticketId);
    if (delivery?.crm_audit_marker === null || delivery === null)
      throw new Error("missing audit marker");

    let auditReads = 0;
    let emailWrites = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.resend.com/emails") {
        emailWrites += 1;
        return Response.json({ id: "unexpected" });
      }
      if (url.endsWith(`/crm/v3/objects/tickets/${ticketId}?associations=notes`)) {
        auditReads += 1;
        return Response.json({ associations: { notes: { results: [{ id: "887766" }] } } });
      }
      if (
        url.endsWith("/crm/v3/objects/notes/887766?properties=hs_note_body&associations=tickets")
      ) {
        auditReads += 1;
        return Response.json({
          id: "887766",
          properties: { hs_note_body: `Prior durable note ${delivery.crm_audit_marker}` },
          associations: { tickets: { results: [{ id: ticketId }] } },
        });
      }
      return new Response("unexpected endpoint", { status: 500 });
    });

    const runtime = {
      DB: env.DB,
      TICKET_WORKFLOW: env.TICKET_WORKFLOW,
      TICKETPILOT_ENV: "demo",
      TICKETPILOT_VERSION: "test",
      NOTION_PARENT_PAGE_ID: "3f3d34323f1a80b48e71c5860aeccc45",
      SLACK_CHANNEL_ID: channel,
      SLACK_TEAM_ID: team,
      SLACK_APPROVER_USER_ID: actor,
      DEMO_START_AT: "2026-10-09T00:09:06.000Z",
      HUBSPOT_SERVICE_KEY: `pat_${"x".repeat(24)}`,
      NOTION_TOKEN: `secret_${"x".repeat(24)}`,
      SLACK_BOT_TOKEN: `xoxb-${"x".repeat(24)}`,
      SLACK_SIGNING_SECRET: "a".repeat(32),
      RESEND_API_KEY: `re_${"x".repeat(24)}`,
      TEST_RECIPIENT_EMAIL: recipient,
      AI: env.AI,
    } as Env;

    let sourceCalls = 0;
    await runScheduledTasks(runtime, {
      async searchDemoTickets() {
        sourceCalls += 1;
        throw new Error("source failure should not suppress CRM audit reconciliation");
      },
    });
    expect(sourceCalls).toBe(1);
    expect(auditReads).toBe(2);
    expect(emailWrites).toBe(0);
    expect((await repository.get(ticketId))?.state).toBe("COMPLETED");
  });
});
