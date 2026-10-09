import { applyD1Migrations, env, introspectWorkflowInstance } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildImmutableEmailPayload, hashEmailPayload } from "../src/adapters/resend";
import type { StoredProposal } from "../src/domain/contracts";
import { dispatchDecisionEvent, TICKET_DECISION_EVENT_TYPE } from "../src/state/decision-events";
import { EmailDeliveryRepository } from "../src/state/email-delivery";
import { TicketRepository } from "../src/state/ticket-repository";
import {
  isAuditHistoryWithinBudget,
  reconcilePendingCrmAudits,
} from "../src/workflows/email-delivery";
import { hashProposal } from "../src/workflows/ticket-workflow";

let firstId = 9_500_000_000_000 + (Date.now() % 100_000_000);
let lastId = firstId + 99;
const channel = "C0C7X4Y182E";
const team = "T0C7S09984V";
const actor = "U0C7X45H86N";
const recipient = "ticketpilot-owner@example.test";
const proposal: StoredProposal = {
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
  promptVersion: "ticketpilot-v1/no-model",
  policyEvidence: [],
};

type MockOptions = {
  resendStatuses?: number[];
  resendNetworkFailure?: boolean;
  noteStatus?: number;
  noteAppearsDespiteError?: boolean;
};

function configureRuntime(): void {
  for (const [key, value] of Object.entries({
    TEST_RECIPIENT_EMAIL: recipient,
    RESEND_API_KEY: `re_${"x".repeat(24)}`,
    HUBSPOT_SERVICE_KEY: `pat_${"x".repeat(24)}`,
    SLACK_BOT_TOKEN: `xoxb-${"x".repeat(24)}`,
    SLACK_APPROVER_USER_ID: actor,
    SLACK_TEAM_ID: team,
    SLACK_CHANNEL_ID: channel,
  })) {
    Object.defineProperty(env, key, { value, configurable: true });
  }
}

async function insertProposal(id: number, stored = proposal): Promise<void> {
  const at = new Date().toISOString();
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
      `[TP-DEMO] Synthetic ${id}`,
      stored.evidence_status === "SUPPORTED" ? "AWAITING_APPROVAL" : "NEEDS_MANUAL_REVIEW",
      stored.category,
      stored.priority,
      stored.evidence_status,
      stored.summary,
      stored.draft_reply,
      JSON.stringify(stored.cited_policy_keys),
      stored.rationale,
      JSON.stringify(stored.policyEvidence),
      stored.proposalHash,
      stored.revision,
      stored.promptVersion,
    )
    .run();
}

async function markPosted(id: number, at = new Date()): Promise<void> {
  await env.DB.prepare(`UPDATE tickets SET state = ?, slack_post_status = 'POSTED',
      slack_post_attempts = 1, slack_team_id = ?, slack_channel = ?, slack_message_ts = ?,
      slack_review_started_at = ?, slack_review_deadline = ? WHERE hubspot_ticket_id = ?`)
    .bind(
      "AWAITING_APPROVAL",
      team,
      channel,
      "1791547200.000001",
      at.toISOString(),
      new Date(at.getTime() + 48 * 60 * 60 * 1_000).toISOString(),
      String(id),
    )
    .run();
}

async function recordDecision(
  id: number,
  decision: "APPROVE" | "REJECT" = "APPROVE",
  actorId = actor,
  now = new Date(),
): Promise<boolean> {
  return new TicketRepository(env.DB).recordSlackDecision({
    ticketId: String(id),
    proposalHash: proposal.proposalHash,
    proposalRevision: proposal.revision,
    teamId: team,
    channelId: channel,
    messageTs: "1791547200.000001",
    decision,
    actorId,
    now,
  });
}

async function startWorkflow(id: number, name: string, earlyPayload?: unknown) {
  const instanceId = `${name}-${id}-${crypto.randomUUID()}`;
  const inspector = await introspectWorkflowInstance(env.TICKET_WORKFLOW, instanceId);
  if (earlyPayload !== undefined) {
    await inspector.modify(async (modifier) => {
      await modifier.mockEvent({ type: TICKET_DECISION_EVENT_TYPE, payload: earlyPayload });
    });
  }
  await env.TICKET_WORKFLOW.create({ id: instanceId, params: { ticketId: String(id) } });
  await inspector.waitForStatus("complete");
  return inspector;
}

function stubProviders(options: MockOptions = {}) {
  const sendRequests: Array<{ body: Record<string, unknown>; idempotencyKey: string | null }> = [];
  const notes = new Map<string, string>();
  const noteCalls: string[] = [];
  let sendIndex = 0;
  let nextNoteId = 77_000;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.resend.com/emails") {
      sendIndex += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sendRequests.push({
        body,
        idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
      });
      if (options.resendNetworkFailure) throw new Error("network details stay private");
      const status = options.resendStatuses?.[sendIndex - 1] ?? 200;
      if (status === 429)
        return new Response("rate limited", { status, headers: { "Retry-After": "0" } });
      if (status !== 200 && status !== 202)
        return new Response("provider body must not escape", { status });
      return Response.json({ id: `email-${sendIndex}` }, { status });
    }
    if (url.includes("/crm/associations/2026-09/notes/tickets/labels")) {
      return Response.json({
        results: [{ category: "HUBSPOT_DEFINED", label: null, typeId: 228 }],
      });
    }
    const associatedNotes = url.match(/\/crm\/v3\/objects\/tickets\/(\d+)\?associations=notes$/);
    if (associatedNotes !== null) {
      const ticketId = associatedNotes[1] ?? "";
      const matches = [...notes.keys()].filter((key) => key.startsWith(`${ticketId}:`));
      return Response.json({
        associations: { notes: { results: matches.map((key) => ({ id: key.split(":")[1] })) } },
      });
    }
    const readNote = url.match(
      /\/crm\/v3\/objects\/notes\/(\d+)\?properties=hs_note_body&associations=tickets$/,
    );
    if (readNote !== null) {
      const noteId = readNote[1] ?? "";
      const found = [...notes.entries()].find(([key]) => key.endsWith(`:${noteId}`));
      const ticketId = found?.[0].split(":")[0] ?? "";
      return Response.json({
        id: noteId,
        properties: { hs_note_body: notes.get(`${ticketId}:${noteId}`) ?? "" },
        associations: { tickets: { results: [{ id: ticketId }] } },
      });
    }
    if (url === "https://api.hubapi.com/crm/v3/objects/notes" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        properties?: { hs_note_body?: string };
        associations?: Array<{ to?: { id?: string } }>;
      };
      noteCalls.push(String(body.properties?.hs_note_body ?? ""));
      const noteId = String(nextNoteId++);
      const ticketId = body.associations?.[0]?.to?.id ?? "";
      if (
        options.noteStatus !== undefined &&
        options.noteStatus >= 400 &&
        !options.noteAppearsDespiteError
      ) {
        return new Response("opaque CRM body", { status: options.noteStatus });
      }
      notes.set(`${ticketId}:${noteId}`, body.properties?.hs_note_body ?? "");
      if (options.noteStatus !== undefined)
        return new Response("opaque CRM body", { status: options.noteStatus });
      return Response.json({ id: noteId }, { status: 201 });
    }
    // Slack message reads/writes in manual-review fixtures are mocked independently from providers.
    return Response.json({ ok: true, channel, ts: "1791547200.000001" });
  });
  return { sendRequests, noteCalls, notes };
}

describe("Phase 4 approved-only email and audit Workflow", () => {
  beforeEach(async () => {
    firstId += 1_000;
    lastId = firstId + 99;
    configureRuntime();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare("DELETE FROM events WHERE ticket_id BETWEEN ? AND ?")
      .bind(String(firstId), String(lastId))
      .run();
    await env.DB.prepare("DELETE FROM tickets WHERE hubspot_ticket_id BETWEEN ? AND ?")
      .bind(String(firstId), String(lastId))
      .run();
  });

  it("accepts bounded escaped history below HubSpot's limit and fails closed on malformed or oversized audit", () => {
    const finalHash = "d".repeat(64);
    const acceptedHistory = Array.from({ length: 4 }, (_, index) => {
      const revision = index + 1;
      const draft = "&".repeat(1_500);
      const summary = "&".repeat(240);
      const snapshot = {
        ...proposal,
        summary,
        draft_reply: draft,
        proposalHash: revision === 4 ? finalHash : String(revision).repeat(64),
        revision,
      };
      return {
        ticket_id: "9500000000001",
        revision,
        proposal_hash: snapshot.proposalHash,
        proposal_json: JSON.stringify(snapshot),
        edit_reason: revision === 1 ? null : "&".repeat(200),
        edited_by: revision === 1 ? null : actor,
        created_at: new Date(Date.UTC(2026, 0, revision)).toISOString(),
      };
    });
    const finalProposal = {
      ...proposal,
      summary: "&".repeat(240),
      draft_reply: "&".repeat(1_500),
      proposalHash: finalHash,
      revision: 4,
    };
    expect(
      isAuditHistoryWithinBudget(acceptedHistory, finalProposal, {
        subject: "Synthetic subject",
        text: finalProposal.draft_reply,
      }),
    ).toBe(true);

    const oversizedHistory = acceptedHistory.map((entry) => {
      const snapshot = JSON.parse(entry.proposal_json) as Record<string, unknown>;
      const revision = entry.revision;
      const hash = revision === 4 ? finalHash : String(revision).repeat(64);
      return {
        ...entry,
        proposal_hash: hash,
        proposal_json: JSON.stringify({
          ...snapshot,
          draft_reply: '"'.repeat(1_500),
          summary: '"'.repeat(240),
          proposalHash: hash,
        }),
        edit_reason: revision === 1 ? null : '"'.repeat(200),
      };
    });
    const oversizedFinal = {
      ...finalProposal,
      draft_reply: '"'.repeat(1_500),
      summary: '"'.repeat(240),
    };
    expect(
      isAuditHistoryWithinBudget(oversizedHistory, oversizedFinal, {
        subject: "Synthetic subject",
        text: oversizedFinal.draft_reply,
      }),
    ).toBe(false);
    expect(
      isAuditHistoryWithinBudget(
        acceptedHistory.map((entry, index) =>
          index === 0 ? { ...entry, proposal_json: "{malformed" } : entry,
        ),
        finalProposal,
        { subject: "Synthetic subject", text: finalProposal.draft_reply },
      ),
    ).toBe(false);
  });

  it("sends exactly once to the configured recipient, then persists and verifies the CRM audit note", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    expect(await recordDecision(firstId)).toBe(true);
    const providers = stubProviders();
    const workflow = await startWorkflow(firstId, "phase4-supported-approved");
    try {
      expect(await workflow.getOutput()).toMatchObject({ status: "completed" });
      expect(providers.sendRequests).toHaveLength(1);
      expect(providers.sendRequests[0]?.idempotencyKey).toBe(`ticketpilot/${firstId}/v1`);
      expect(providers.sendRequests[0]?.body.to).toEqual([recipient]);
      expect(providers.sendRequests[0]?.body.to).not.toContain("customer@example.com");
      expect(providers.sendRequests[0]?.body.subject).toBe(
        `[TicketPilot DEMO] Ticket ${firstId} — Synthetic ${firstId}`,
      );
      expect(providers.sendRequests[0]?.body.text).toBe(proposal.draft_reply);
      expect(JSON.stringify(providers.sendRequests[0]?.body)).not.toMatch(
        /Category:|Priority:|Summary:|Rationale:|Policy keys:/,
      );
      expect(providers.noteCalls).toHaveLength(1);
      expect(providers.noteCalls[0]).toContain("[TICKETPILOT-AUDIT:");
      expect(providers.noteCalls[0]).toContain("Resend message ID: email-1");
      expect(providers.noteCalls[0]).toContain("Recipient: t***@example.test");
      expect(providers.noteCalls[0]).not.toContain(recipient);
      const row = await new EmailDeliveryRepository(env.DB).get(String(firstId));
      expect(row).toMatchObject({
        state: "COMPLETED",
        resend_attempts: 1,
        resend_message_id: "email-1",
        crm_audit_status: "COMPLETED",
        crm_audit_attempts: 1,
      });
      expect(row?.hubspot_note_id).not.toBeNull();
      expect(row?.crm_audit_candidate_note_id).toBe(row?.hubspot_note_id);
    } finally {
      await workflow.dispose();
    }
  });

  it("sends only the latest of two human revisions and records original, reasons, hashes, exact text, and receipt in HubSpot", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    const repository = new TicketRepository(env.DB);
    const firstEdit = {
      ...proposal,
      draft_reply: "First revision: confirm the charge dates before resolving.",
      summary: "Check charge dates",
    };
    const firstHash = await hashProposal({
      ticketId: String(firstId),
      revision: 2,
      proposal: firstEdit,
      evidence: proposal.policyEvidence,
      promptVersion: proposal.promptVersion,
    });
    expect(
      await repository.editProposal({
        ticketId: String(firstId),
        expectedHash: proposal.proposalHash,
        expectedRevision: 1,
        proposal: firstEdit,
        proposalHash: firstHash,
        reason: "Clarified which billing dates are checked.",
        editorId: actor,
        teamId: team,
        channelId: channel,
        messageTs: "1791547200.000001",
      }),
    ).toBe(true);
    let token = crypto.randomUUID();
    expect(await repository.reserveSlackRefresh(String(firstId), 2, token)).toBe(true);
    expect(await repository.completeSlackRefresh(String(firstId), 2, token)).toBe(true);

    const finalText =
      "Final revision: <script>alert(1)</script> We will review both charges and their dates.";
    const finalEdit = { ...firstEdit, draft_reply: finalText, summary: "Review both charges" };
    const finalHash = await hashProposal({
      ticketId: String(firstId),
      revision: 3,
      proposal: finalEdit,
      evidence: proposal.policyEvidence,
      promptVersion: proposal.promptVersion,
    });
    expect(
      await repository.editProposal({
        ticketId: String(firstId),
        expectedHash: firstHash,
        expectedRevision: 2,
        proposal: finalEdit,
        proposalHash: finalHash,
        reason: "Adjusted the resolution after reviewing both charges.",
        editorId: actor,
        teamId: team,
        channelId: channel,
        messageTs: "1791547200.000001",
      }),
    ).toBe(true);
    token = crypto.randomUUID();
    expect(await repository.reserveSlackRefresh(String(firstId), 3, token)).toBe(true);
    expect(await repository.completeSlackRefresh(String(firstId), 3, token)).toBe(true);

    expect(
      await repository.recordSlackDecision({
        ticketId: String(firstId),
        proposalHash: proposal.proposalHash,
        proposalRevision: 1,
        teamId: team,
        channelId: channel,
        messageTs: "1791547200.000001",
        decision: "APPROVE",
        actorId: actor,
      }),
    ).toBe(false);
    expect(await repository.getSlackReviewState(String(firstId))).toMatchObject({
      decision: null,
      proposal_revision: 3,
    });
    expect(
      await repository.recordSlackDecision({
        ticketId: String(firstId),
        proposalHash: finalHash,
        proposalRevision: 3,
        teamId: team,
        channelId: channel,
        messageTs: "1791547200.000001",
        decision: "APPROVE",
        actorId: actor,
      }),
    ).toBe(true);

    const providers = stubProviders();
    const workflow = await startWorkflow(firstId, "phase4-two-human-revisions-latest-only");
    try {
      expect(await workflow.getOutput()).toMatchObject({ status: "completed" });
      expect(providers.sendRequests).toHaveLength(1);
      expect(providers.sendRequests[0]?.body.text).toBe(finalText);
      expect(providers.noteCalls).toHaveLength(1);
      const note = providers.noteCalls[0] ?? "";
      expect(note).toContain(`Revision 1 SHA-256: ${proposal.proposalHash}`);
      expect(note).toContain(`Revision 2 SHA-256: ${firstHash}`);
      expect(note).toContain(`Revision 3 SHA-256: ${finalHash}`);
      expect(note).toContain("Clarified which billing dates are checked.");
      expect(note).toContain("Adjusted the resolution after reviewing both charges.");
      expect(note).toContain("First revision: confirm the charge dates before resolving.");
      expect(note).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(note).not.toContain("<script>");
      expect(note).toContain("Exact sent text:");
      expect(note).toContain("Resend message ID: email-1");
      expect(
        (await repository.getProposalRevisionHistory(String(firstId))).map((item) => item.revision),
      ).toEqual([1, 2, 3]);
    } finally {
      await workflow.dispose();
    }
  });

  it("reloads and sends the latest edited revision when an already-waiting Workflow receives its decision", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    const repository = new TicketRepository(env.DB);
    const instanceId = `phase4-waiting-edit-${firstId}-${crypto.randomUUID()}`;
    await env.DB.prepare("UPDATE tickets SET workflow_instance_id = ? WHERE hubspot_ticket_id = ?")
      .bind(instanceId, String(firstId))
      .run();
    const inspector = await introspectWorkflowInstance(env.TICKET_WORKFLOW, instanceId);
    const providers = stubProviders();
    await env.TICKET_WORKFLOW.create({ id: instanceId, params: { ticketId: String(firstId) } });
    try {
      await inspector.waitForStepResult({ name: "phase3-load-slack-review" });
      const edited = {
        ...proposal,
        draft_reply: "Response edited while the Workflow was waiting: review both charge dates.",
        summary: "Review both charge dates",
      };
      const editedHash = await hashProposal({
        ticketId: String(firstId),
        revision: 2,
        proposal: edited,
        evidence: proposal.policyEvidence,
        promptVersion: proposal.promptVersion,
      });
      expect(
        await repository.editProposal({
          ticketId: String(firstId),
          expectedHash: proposal.proposalHash,
          expectedRevision: 1,
          proposal: edited,
          proposalHash: editedHash,
          reason: "Clarified the solution while review was open.",
          editorId: actor,
          teamId: team,
          channelId: channel,
          messageTs: "1791547200.000001",
        }),
      ).toBe(true);
      const token = crypto.randomUUID();
      expect(await repository.reserveSlackRefresh(String(firstId), 2, token)).toBe(true);
      expect(await repository.completeSlackRefresh(String(firstId), 2, token)).toBe(true);
      expect(
        await repository.recordSlackDecision({
          ticketId: String(firstId),
          proposalHash: editedHash,
          proposalRevision: 2,
          teamId: team,
          channelId: channel,
          messageTs: "1791547200.000001",
          decision: "APPROVE",
          actorId: actor,
        }),
      ).toBe(true);
      await dispatchDecisionEvent(String(firstId), repository, env.TICKET_WORKFLOW);
      await inspector.waitForStatus("complete");
      expect(await inspector.getOutput()).toMatchObject({ status: "completed" });
      expect(providers.sendRequests).toHaveLength(1);
      expect(providers.sendRequests[0]?.body.text).toBe(edited.draft_reply);
      expect(providers.noteCalls[0]).toContain(
        "Response text: Response edited while the Workflow was waiting",
      );
    } finally {
      await inspector.dispose();
    }
  });

  it("handles an allowlisted approval that lands after Slack post receipt but before review confirmation", async () => {
    await insertProposal(firstId);
    const providers = stubProviders();
    const repository = new TicketRepository(env.DB);
    const originalCompleteSlackPost = TicketRepository.prototype.completeSlackPost;
    const completeSpy = vi
      .spyOn(TicketRepository.prototype, "completeSlackPost")
      .mockImplementation(async (ticketId, teamId, channelId, messageTs, now) => {
        const posted = await originalCompleteSlackPost.call(
          repository,
          ticketId,
          teamId,
          channelId,
          messageTs,
          now,
        );
        if (posted) {
          expect(
            await repository.recordSlackDecision({
              ticketId,
              proposalHash: proposal.proposalHash,
              proposalRevision: proposal.revision,
              teamId,
              channelId,
              messageTs,
              decision: "APPROVE",
              actorId: actor,
            }),
          ).toBe(true);
        }
        return posted;
      });
    const workflow = await startWorkflow(firstId, "phase4-approval-after-slack-receipt");
    try {
      expect(await workflow.getOutput()).toMatchObject({ status: "completed" });
      expect(providers.sendRequests).toHaveLength(1);
      expect(providers.noteCalls).toHaveLength(1);
      expect(await repository.getSlackReviewState(String(firstId))).toMatchObject({
        decision: "APPROVE",
        slack_post_status: "POSTED",
        state: "COMPLETED",
      });
    } finally {
      completeSpy.mockRestore();
      await workflow.dispose();
    }
  });

  it("reconciles duplicate Workflow executions without resending or recreating the audit note", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    await recordDecision(firstId);
    const providers = stubProviders();
    const first = await startWorkflow(firstId, "phase4-first-instance");
    await first.dispose();
    const second = await startWorkflow(firstId, "phase4-duplicate-instance");
    try {
      expect(await second.getOutput()).toMatchObject({ status: "completed" });
      expect(providers.sendRequests).toHaveLength(1);
      expect(providers.noteCalls).toHaveLength(1);
    } finally {
      await second.dispose();
    }
  });

  it("retries a stored legacy payload unchanged and does not resend after completion", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    await recordDecision(firstId);
    const legacyPayload = {
      from: "TicketPilot Demo <onboarding@resend.dev>" as const,
      to: [recipient] as [string],
      subject: `[TicketPilot DEMO] Ticket ${firstId} — Response`,
      text: [
        `Ticket ${firstId}`,
        `Category: ${proposal.category}`,
        `Priority: ${proposal.priority}`,
        `Summary: ${proposal.summary}`,
        "",
        proposal.draft_reply,
      ].join("\n"),
    };
    const legacyJson = JSON.stringify(legacyPayload);
    const legacyHash = await hashEmailPayload(legacyPayload);
    const repository = new EmailDeliveryRepository(env.DB);
    expect(
      await repository.reserveApprovedEmail(
        String(firstId),
        {
          proposalHash: proposal.proposalHash,
          proposalRevision: proposal.revision,
          approverId: actor,
          teamId: team,
          channelId: channel,
        },
        {
          payloadJson: legacyJson,
          payloadHash: legacyHash,
          idempotencyKey: `ticketpilot/${firstId}/v1`,
          recipientAlias: "t***@example.test",
        },
      ),
    ).toBe(true);
    const now = new Date();
    expect(await repository.recordRateLimit(String(firstId), 1, now, now)).toBe("retry_pending");
    const providers = stubProviders({ resendStatuses: [200] });
    const retry = await startWorkflow(firstId, "phase4-legacy-payload-retry");
    await retry.dispose();
    expect(await repository.get(String(firstId))).toMatchObject({
      state: "COMPLETED",
      immutable_email_payload_json: legacyJson,
      approved_payload_hash: legacyHash,
    });
    expect(providers.sendRequests).toHaveLength(1);
    expect(providers.sendRequests[0]?.body).toEqual(legacyPayload);

    const replay = await startWorkflow(firstId, "phase4-legacy-payload-completed-replay");
    try {
      expect(await replay.getOutput()).toMatchObject({ status: "completed" });
      expect(providers.sendRequests).toHaveLength(1);
      expect((await repository.get(String(firstId)))?.immutable_email_payload_json).toBe(
        legacyJson,
      );
    } finally {
      await replay.dispose();
    }
  });

  it.each([
    ["409 conflict", 409],
    ["5xx ambiguous response", 503],
  ])("marks %s unknown and never retries the send", async (_label, status) => {
    await insertProposal(firstId);
    await markPosted(firstId);
    await recordDecision(firstId);
    const providers = stubProviders({ resendStatuses: [status] });
    const first = await startWorkflow(firstId, "phase4-ambiguous-send");
    await first.dispose();
    const second = await startWorkflow(firstId, "phase4-ambiguous-replay");
    try {
      expect(await second.getOutput()).toMatchObject({ status: "send_unknown" });
      expect(providers.sendRequests).toHaveLength(1);
      expect(providers.noteCalls).toHaveLength(0);
      expect((await new EmailDeliveryRepository(env.DB).get(String(firstId)))?.state).toBe(
        "SEND_UNKNOWN",
      );
    } finally {
      await second.dispose();
    }
  });

  it("marks a lost network response unknown and never retries it on Workflow replay", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    await recordDecision(firstId);
    const providers = stubProviders({ resendNetworkFailure: true });
    const first = await startWorkflow(firstId, "phase4-network-send-loss");
    await first.dispose();
    const second = await startWorkflow(firstId, "phase4-network-send-replay");
    try {
      expect(await second.getOutput()).toMatchObject({ status: "send_unknown" });
      expect(providers.sendRequests).toHaveLength(1);
      expect((await new EmailDeliveryRepository(env.DB).get(String(firstId)))?.state).toBe(
        "SEND_UNKNOWN",
      );
    } finally {
      await second.dispose();
    }
  });

  it("retries only definite 429 responses at most three times with the same body and key", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    await recordDecision(firstId);
    const providers = stubProviders({ resendStatuses: [429, 429, 429, 200] });
    const workflow = await startWorkflow(firstId, "phase4-rate-limit-bounded");
    try {
      expect(await workflow.getOutput()).toMatchObject({ status: "send_failed" });
      expect(providers.sendRequests).toHaveLength(3);
      expect(new Set(providers.sendRequests.map((request) => request.idempotencyKey))).toEqual(
        new Set([`ticketpilot/${firstId}/v1`]),
      );
      expect(
        new Set(providers.sendRequests.map((request) => JSON.stringify(request.body))),
      ).toHaveLength(1);
      expect((await new EmailDeliveryRepository(env.DB).get(String(firstId)))?.state).toBe(
        "SEND_FAILED",
      );
    } finally {
      await workflow.dispose();
    }
  });

  it("retries two definite 429 responses then accepts once using the same key and payload", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    await recordDecision(firstId);
    const providers = stubProviders({ resendStatuses: [429, 429, 200] });
    const workflow = await startWorkflow(firstId, "phase4-two-rate-limits");
    try {
      expect(await workflow.getOutput()).toMatchObject({ status: "completed" });
      expect(providers.sendRequests).toHaveLength(3);
      expect(new Set(providers.sendRequests.map((request) => request.idempotencyKey))).toEqual(
        new Set([`ticketpilot/${firstId}/v1`]),
      );
      expect(
        new Set(providers.sendRequests.map((request) => JSON.stringify(request.body))),
      ).toHaveLength(1);
      expect(
        (await new EmailDeliveryRepository(env.DB).get(String(firstId)))?.resend_attempts,
      ).toBe(3);
    } finally {
      await workflow.dispose();
    }
  });

  it.each([
    11 * 60 * 1_000,
    25 * 60 * 60 * 1_000,
  ])("refuses a 429 retry after the bounded window (%i ms)", async (ageMs) => {
    const id = firstId + (ageMs > 24 * 60 * 60 * 1_000 ? 4 : 3);
    const firstAttemptAt = new Date(Date.now() - ageMs);
    await insertProposal(id);
    await markPosted(id, firstAttemptAt);
    expect(await recordDecision(id, "APPROVE", actor, firstAttemptAt)).toBe(true);
    const payload = buildImmutableEmailPayload(String(id), proposal, recipient);
    const hash = await hashEmailPayload(payload);
    const repository = new EmailDeliveryRepository(env.DB);
    expect(
      await repository.reserveApprovedEmail(
        String(id),
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
          idempotencyKey: `ticketpilot/${id}/v1`,
          recipientAlias: "t***@example.test",
        },
        firstAttemptAt,
      ),
    ).toBe(true);
    expect(
      await repository.recordRateLimit(
        String(id),
        1,
        new Date(firstAttemptAt.getTime() + 1_000),
        firstAttemptAt,
      ),
    ).toBe("retry_pending");
    expect(
      await repository.reserveRateLimitRetry(
        String(id),
        2,
        new Date(firstAttemptAt.getTime() + ageMs),
      ),
    ).toBe(false);
    expect(
      await repository.failExpiredRateLimitRetry(
        String(id),
        1,
        new Date(firstAttemptAt.getTime() + ageMs),
      ),
    ).toBe(true);
    expect((await repository.get(String(id)))?.state).toBe("SEND_FAILED");
  });

  it("does not send when the approval actor is not the configured human", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    expect(await recordDecision(firstId, "APPROVE", "U_NOT_ALLOWLISTED")).toBe(true);
    const providers = stubProviders();
    const workflow = await startWorkflow(firstId, "phase4-forged-actor");
    try {
      expect(await workflow.getOutput()).toMatchObject({ status: "manual_review" });
      expect(providers.sendRequests).toHaveLength(0);
      expect(providers.noteCalls).toHaveLength(0);
    } finally {
      await workflow.dispose();
    }
  });

  it("does not send after a durable rejection", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    await recordDecision(firstId, "REJECT");
    const providers = stubProviders();
    const workflow = await startWorkflow(firstId, "phase4-rejected");
    try {
      expect(await workflow.getOutput()).toMatchObject({
        status: "decision_received",
        decision: "REJECT",
      });
      expect(providers.sendRequests).toHaveLength(0);
    } finally {
      await workflow.dispose();
    }
  });

  it("does not send after an expired review", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    await env.DB.prepare("UPDATE tickets SET state = 'EXPIRED' WHERE hubspot_ticket_id = ?")
      .bind(String(firstId))
      .run();
    const providers = stubProviders();
    const workflow = await startWorkflow(firstId, "phase4-expired-review");
    try {
      expect(await workflow.getOutput()).toMatchObject({ status: "expired" });
      expect(providers.sendRequests).toHaveLength(0);
    } finally {
      await workflow.dispose();
    }
  });

  it("does not send from a preloaded approval event when proposal evidence is unsupported", async () => {
    await insertProposal(firstId, unsupportedProposal);
    const providers = stubProviders();
    const workflow = await startWorkflow(firstId, "phase4-unsupported-early-event", {
      ticketId: String(firstId),
      decision: "APPROVE",
      actorId: actor,
      decidedAt: new Date().toISOString(),
      proposalHash: unsupportedProposal.proposalHash,
      proposalRevision: unsupportedProposal.revision,
    });
    try {
      expect(await workflow.getOutput()).toMatchObject({ status: "manual_review" });
      expect(providers.sendRequests).toHaveLength(0);
    } finally {
      await workflow.dispose();
    }
  });

  it("does not resend after an ambiguous CRM write and recovers by marker/association read only", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    await recordDecision(firstId);
    const providers = stubProviders({ noteStatus: 503, noteAppearsDespiteError: true });
    const workflow = await startWorkflow(firstId, "phase4-crm-write-ambiguous");
    await workflow.dispose();
    expect(await new EmailDeliveryRepository(env.DB).get(String(firstId))).toMatchObject({
      state: "EMAIL_ACCEPTED_PENDING_CRM_AUDIT",
      crm_audit_status: "UNKNOWN",
      resend_message_id: "email-1",
    });

    expect(await reconcilePendingCrmAudits(env)).toEqual({ inspected: 1, completed: 1 });
    const row = await new EmailDeliveryRepository(env.DB).get(String(firstId));
    expect(row).toMatchObject({ state: "COMPLETED", crm_audit_status: "COMPLETED" });
    expect(providers.sendRequests).toHaveLength(1);
    expect(providers.noteCalls).toHaveLength(1);
  });

  it("keeps unknown CRM writes audit-only and never blindly retries note creation or email", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    await recordDecision(firstId);
    const providers = stubProviders({ noteStatus: 503 });
    const workflow = await startWorkflow(firstId, "phase4-crm-unknown-no-marker");
    await workflow.dispose();
    expect(await reconcilePendingCrmAudits(env)).toEqual({ inspected: 1, completed: 0 });
    const replay = await startWorkflow(firstId, "phase4-crm-unknown-replay");
    try {
      expect(await replay.getOutput()).toMatchObject({ status: "crm_audit_pending" });
      expect(providers.sendRequests).toHaveLength(1);
      expect(providers.noteCalls).toHaveLength(1);
      expect(
        (await new EmailDeliveryRepository(env.DB).get(String(firstId)))?.crm_audit_status,
      ).toBe("UNKNOWN");
    } finally {
      await replay.dispose();
    }
  });

  it("does not automatically repeat fatal HubSpot audit rejections", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    await recordDecision(firstId);
    const providers = stubProviders({ noteStatus: 403 });
    const workflow = await startWorkflow(firstId, "phase4-fatal-crm-audit");
    await workflow.dispose();
    expect(await reconcilePendingCrmAudits(env)).toEqual({ inspected: 1, completed: 0 });
    const replay = await startWorkflow(firstId, "phase4-fatal-crm-audit-replay");
    try {
      expect(await replay.getOutput()).toMatchObject({ status: "crm_audit_pending" });
      expect(providers.sendRequests).toHaveLength(1);
      expect(providers.noteCalls).toHaveLength(1);
      expect(
        (await new EmailDeliveryRepository(env.DB).get(String(firstId)))?.crm_audit_status,
      ).toBe("UNKNOWN");
    } finally {
      await replay.dispose();
    }
  });

  it("does not reserve delivery for malformed approval state or expired durable approval", async () => {
    await insertProposal(firstId);
    await markPosted(firstId);
    await recordDecision(firstId);
    await env.DB.prepare("UPDATE tickets SET state = 'EXPIRED' WHERE hubspot_ticket_id = ?")
      .bind(String(firstId))
      .run();
    const providers = stubProviders();
    const workflow = await startWorkflow(firstId, "phase4-tampered-expiry");
    try {
      expect(await workflow.getOutput()).toMatchObject({ status: "manual_review" });
      expect(providers.sendRequests).toHaveLength(0);
      expect(
        (await new EmailDeliveryRepository(env.DB).get(String(firstId)))?.resend_attempts,
      ).toBe(0);
    } finally {
      await workflow.dispose();
    }
  });
});
