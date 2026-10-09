import { describe, expect, it } from "vitest";
import { auditContainsEditedEvidence, verifyEditedLedger } from "../scripts/edit-evidence";
import { hashEmailPayload, type ImmutableEmailPayload } from "../src/adapters/resend";

const originalHash = "a".repeat(64);
const editedHash = "b".repeat(64);
const owner = "UDEMO";
const recipient = "owner@example.test";

async function fixture() {
  const payload: ImmutableEmailPayload = {
    from: "TicketPilot Demo <onboarding@resend.dev>",
    to: [recipient],
    subject: "[TicketPilot DEMO] Ticket 123 — Premium activation",
    text: "Edited reply <literal> & safe.",
  };
  const history = [
    {
      ticket_id: "123",
      revision: 1,
      proposal_hash: originalHash,
      proposal_json: JSON.stringify({
        revision: 1,
        proposalHash: originalHash,
        draft_reply: "Original reply.",
        summary: "Original proposed solution.",
      }),
      edit_reason: null,
      edited_by: null,
      created_at: "2026-10-09T12:00:00.000Z",
    },
    {
      ticket_id: "123",
      revision: 2,
      proposal_hash: editedHash,
      proposal_json: JSON.stringify({
        revision: 2,
        proposalHash: editedHash,
        draft_reply: payload.text,
        summary: "Revised proposed solution.",
      }),
      edit_reason: "Changed proposed resolution",
      edited_by: owner,
      created_at: "2026-10-09T12:01:00.000Z",
    },
  ];
  const row = {
    hubspot_ticket_id: "123",
    subject: "[TP-DEMO] Premium activation",
    state: "COMPLETED",
    evidence_status: "SUPPORTED",
    decision: "APPROVE",
    decision_by: owner,
    proposal_revision: 2,
    proposal_hash: editedHash,
    approved_payload_hash: await hashEmailPayload(payload),
    immutable_email_payload_json: JSON.stringify(payload),
    resend_attempts: 1,
    resend_message_id: "receipt-1",
    hubspot_note_id: "456",
    crm_audit_status: "COMPLETED",
    crm_audit_marker: "marker",
  };
  return { row, history, payload };
}

describe("Edited delivery evidence checker", () => {
  it("requires latest exact payload and durable human revision provenance", async () => {
    const { row, history } = await fixture();
    const result = await verifyEditedLedger(row, history, owner, recipient);
    expect(result).toMatchObject({
      ticketId: "123",
      revision: 2,
      noteId: "456",
      receipt: "receipt-1",
    });
    expect(result.noteFragments).toContain("Original reply.");
    expect(result.noteFragments).toContain("Changed proposed resolution");
    expect(result.noteFragments).toContain(originalHash);
    expect(result.noteFragments).toContain("Original proposed solution.");
    expect(result.noteFragments).toContain("2026-10-09T12:00:00.000Z");
  });

  it.each([
    "old_text",
    "wrong_hash",
    "wrong_recipient",
    "wrong_actor",
    "missing_history",
    "duplicate_send",
    "not_completed",
    "wrong_subject",
  ])("rejects %s without manufacturing live acceptance", async (change) => {
    const { row, history, payload } = await fixture();
    if (change === "old_text") payload.text = "Original reply.";
    if (change === "wrong_recipient") payload.to[0] = "other@example.test";
    if (change === "wrong_subject") payload.subject = "old subject";
    row.immutable_email_payload_json = JSON.stringify(payload);
    if (change === "wrong_hash") row.approved_payload_hash = originalHash;
    if (change === "wrong_actor" && history[1]) history[1].edited_by = "UOTHER";
    if (change === "missing_history") history.shift();
    if (change === "duplicate_send") row.resend_attempts = 2;
    if (change === "not_completed") row.state = "APPROVED";
    await expect(verifyEditedLedger(row, history, owner, recipient)).rejects.toThrow();
  });

  it("matches escaped audit text exactly once, not HTML-injected or double-escaped content", () => {
    const fragments = ["Edited <literal> & safe.", "Original reply."];
    expect(
      auditContainsEditedEvidence(
        "<div>Original reply.<br>Edited &lt;literal&gt; &amp; safe.</div>",
        fragments,
      ),
    ).toBe(true);
    expect(
      auditContainsEditedEvidence(
        "<div>Original reply.<br>Edited <literal> & safe.</div>",
        fragments,
      ),
    ).toBe(false);
    expect(
      auditContainsEditedEvidence(
        "Original reply. Edited &amp;lt;literal&amp;gt; &amp;amp; safe.",
        fragments,
      ),
    ).toBe(false);
    expect(auditContainsEditedEvidence("Original reply.", fragments)).toBe(false);
  });
});
