import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { attestationSchema, matchOwnerEvidence } from "./human-evidence";
import {
  assertHealth,
  configured,
  projectRoot,
  readDemoLedger,
  readJson,
  requireDemo,
  seedIds,
  verifyNoteAssociation,
  workerUrl,
} from "./live-inspection";

async function main(): Promise<void> {
  requireDemo();
  assertHealth(await readJson(`${workerUrl}/health`));
  const ids = await seedIds();
  const rows = readDemoLedger(Object.values(ids));
  const approver = configured("SLACK_APPROVER_USER_ID");
  const approved = rows.filter(
    (row) =>
      row.state === "COMPLETED" &&
      row.evidence_status === "SUPPORTED" &&
      row.decision === "APPROVE" &&
      row.decision_by === approver &&
      typeof row.resend_message_id === "string" &&
      typeof row.hubspot_note_id === "string" &&
      typeof row.crm_audit_marker === "string" &&
      row.crm_audit_status === "COMPLETED" &&
      row.crm_audit_candidate_note_id === row.hubspot_note_id &&
      row.acceptance_event_count === 1 &&
      row.audit_event_count === 1,
  );
  const approvedVerified: typeof rows = [];
  for (const row of approved) {
    if (
      await verifyNoteAssociation(
        String(row.hubspot_note_id),
        String(row.hubspot_ticket_id),
        String(row.crm_audit_marker),
        String(row.resend_message_id),
      )
    ) {
      approvedVerified.push(row);
    }
  }
  const rejected = rows.filter(
    (row) =>
      row.state === "REJECTED" &&
      row.decision === "REJECT" &&
      row.evidence_status === "SUPPORTED" &&
      row.resend_attempts === 0 &&
      row.decision_by === approver &&
      row.resend_message_id === null,
  );
  const unknown = rows.find((row) => row.hubspot_ticket_id === ids["unknown-unrelated"]);
  const manualSafe =
    unknown?.evidence_status === "INSUFFICIENT_EVIDENCE" &&
    unknown.slack_post_status === "POSTED" &&
    unknown.slack_post_attempts === 1 &&
    unknown.resend_message_id === null &&
    unknown.resend_attempts === 0 &&
    ["NEEDS_MANUAL_REVIEW", "REJECTED", "EXPIRED"].includes(String(unknown.state)) &&
    unknown.decision !== "APPROVE";
  const technicalPassed = approvedVerified.length > 0 && rejected.length > 0 && manualSafe;
  const path = resolve(projectRoot, "artifacts/human-acceptance.json");
  if (process.argv.includes("--record-human-evidence")) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error("interactive_owner_required");
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const ticket = (
        await input.question("Ticket ID whose Approve button YOU physically clicked: ")
      ).trim();
      const row = approvedVerified.find((item) => item.hubspot_ticket_id === ticket);
      if (!row) throw new Error("approved_audited_ticket_required");
      const receipt = String(row.resend_message_id);
      const click = await input.question(
        `Type I CLICKED ${ticket} to attest your physical Slack click (not a simulator): `,
      );
      const inbox = await input.question(
        `After checking this particular email, type RECEIVED ${receipt}: `,
      );
      if (click.trim() !== `I CLICKED ${ticket}` || inbox.trim() !== `RECEIVED ${receipt}`) {
        throw new Error("owner_confirmation_missing");
      }
      const record = attestationSchema.parse({
        source: "interactive_owner_attestation",
        ticket_id: ticket,
        resend_message_id: receipt,
        decision_at: row.decision_at,
        recorded_at: new Date().toISOString(),
        physical_click_confirmed: true,
        particular_message_inbox_confirmed: true,
      });
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    } finally {
      input.close();
    }
  }
  let humanSource: "interactive_owner_attestation" | "owner_chat_confirmation" | null = null;
  try {
    humanSource = matchOwnerEvidence(JSON.parse(await readFile(path, "utf8")), approvedVerified);
  } catch {
    /* Missing or invalid operator evidence is pending, never inferred. */
  }
  const human = humanSource !== null;
  const report = {
    generated_at: new Date().toISOString(),
    evidence_label: "LIVE_PROVIDER",
    mode: "read_only_provider_and_ledger_verification",
    approved_with_receipt_and_verified_note: approvedVerified.map((row) => row.hubspot_ticket_id),
    rejected_without_email: rejected.map((row) => row.hubspot_ticket_id),
    unknown_manual_no_email: manualSafe,
    technical_scenarios_passed: technicalPassed,
    human_evidence_source: humanSource,
    human_click_and_inbox_confirmed: human,
    status: !technicalPassed
      ? "PENDING_LIVE_SCENARIOS"
      : human
        ? "LIVE_ACCEPTANCE_PASSED"
        : "PENDING_HUMAN_LIVE_ACCEPTANCE",
    note: "D1 provider receipts are checked, not independently fetched from send-only Resend. A signed simulator is not a human click; overall DONE also requires all other project gates.",
  };
  await writeFile(
    resolve(projectRoot, "artifacts/e2e-redacted.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report));
  if (!technicalPassed || !human) process.exitCode = 2;
}

main().catch(() => {
  console.error("e2e_verification_failed_no_sensitive_details_logged");
  process.exitCode = 1;
});
