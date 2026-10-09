import { z } from "zod";
import { auditContainsEditedEvidence, verifyEditedLedger } from "./edit-evidence";
import {
  assertHealth,
  configured,
  readJson,
  readRemoteRows,
  requireDemo,
  verifyNoteAssociation,
  workerUrl,
} from "./live-inspection";

async function main(): Promise<void> {
  if (process.argv.includes("--help")) {
    console.log(
      "Read-only: npm run verify:edit -- --ticket <synthetic-ticket-id>. Requires configured demo credentials and Wrangler auth. Never sends or records human attestation.",
    );
    return;
  }
  requireDemo();
  const at = process.argv.indexOf("--ticket");
  const id = z
    .string()
    .regex(/^\d{1,20}$/)
    .parse(at < 0 ? undefined : process.argv[at + 1]);
  assertHealth(await readJson(`${workerUrl}/health`));
  const rows = readRemoteRows(
    `SELECT hubspot_ticket_id,subject,state,evidence_status,decision,decision_by,proposal_revision,proposal_hash,approved_payload_hash,immutable_email_payload_json,resend_attempts,resend_message_id,hubspot_note_id,crm_audit_status,crm_audit_marker FROM tickets WHERE hubspot_ticket_id='${id}'`,
  );
  const history = readRemoteRows(
    `SELECT ticket_id,revision,proposal_hash,proposal_json,edit_reason,edited_by,created_at FROM proposal_revisions WHERE ticket_id='${id}' ORDER BY revision LIMIT 5`,
  );
  const evidence = await verifyEditedLedger(
    rows[0],
    history,
    configured("SLACK_APPROVER_USER_ID"),
    configured("TEST_RECIPIENT_EMAIL"),
  );
  const note = z
    .object({ properties: z.object({ hs_note_body: z.string() }) })
    .parse(
      await readJson(
        `https://api.hubapi.com/crm/v3/objects/notes/${evidence.noteId}?properties=hs_note_body`,
        configured("HUBSPOT_SERVICE_KEY"),
      ),
    );
  if (
    !auditContainsEditedEvidence(note.properties.hs_note_body, evidence.noteFragments) ||
    !(await verifyNoteAssociation(evidence.noteId, id, evidence.marker, evidence.receipt))
  )
    throw new Error("edited_crm_audit_not_verified");
  console.log(
    JSON.stringify({
      status: "EDITED_PROVIDER_EVIDENCE_PASSED",
      ticket_id: id,
      approved_sent_revision: evidence.revision,
      exact_latest_text_and_payload_hash: true,
      original_and_edits_in_unique_associated_note: true,
      evidence_label: "LIVE_PROVIDER",
      human_modal_click_and_particular_inbox_confirmation: "requires_separate_owner_confirmation",
    }),
  );
}

main().catch(() => {
  console.error(
    JSON.stringify({
      status: "PENDING_EDITED_LIVE_EVIDENCE",
      note: "No writes performed. Check ticket completion, revisions, exact payload and associated audit; no human or inbox evidence inferred.",
    }),
  );
  process.exitCode = 2;
});
