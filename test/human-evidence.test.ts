import { describe, expect, it } from "vitest";
import { matchOwnerEvidence } from "../scripts/human-evidence";

const record = {
  source: "owner_chat_confirmation",
  ticket_id: "123",
  resend_message_id: "receipt-123",
  decision_at: "2026-10-09T02:00:00Z",
  recorded_at: "2026-10-09T02:01:00Z",
  physical_click_confirmed: true,
  particular_message_inbox_confirmed: true,
};
const rows = [
  {
    hubspot_ticket_id: "123",
    resend_message_id: "receipt-123",
    decision_at: record.decision_at,
  },
];

describe("explicit owner evidence", () => {
  it("preserves chat provenance rather than claiming an interactive terminal", () => {
    expect(matchOwnerEvidence(record, rows)).toBe("owner_chat_confirmation");
    expect(matchOwnerEvidence({ ...record, source: "interactive_owner_attestation" }, rows)).toBe(
      "interactive_owner_attestation",
    );
  });

  it("rejects simulator and unrecognized evidence sources", () => {
    expect(matchOwnerEvidence({ ...record, source: "SIGNED_SLACK_SIMULATOR" }, rows)).toBeNull();
  });

  it("requires both actual click and particular inbox confirmation", () => {
    expect(matchOwnerEvidence({ ...record, physical_click_confirmed: false }, rows)).toBeNull();
    expect(
      matchOwnerEvidence({ ...record, particular_message_inbox_confirmed: false }, rows),
    ).toBeNull();
  });

  it("binds ticket, receipt and decision timestamp to directly verified rows", () => {
    for (const changed of [
      { ticket_id: "456" },
      { resend_message_id: "another-receipt" },
      { decision_at: "2026-10-08T02:00:00Z" },
    ]) {
      expect(matchOwnerEvidence({ ...record, ...changed }, rows)).toBeNull();
    }
    expect(matchOwnerEvidence(record, [])).toBeNull();
  });

  it("fails closed for missing, malformed or incomplete records", () => {
    for (const invalid of [null, {}, { ...record, recorded_at: "unknown" }]) {
      expect(matchOwnerEvidence(invalid, rows)).toBeNull();
    }
  });
});
