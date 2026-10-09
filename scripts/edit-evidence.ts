import { z } from "zod";
import {
  buildDemoEmailSubject,
  hashEmailPayload,
  immutableEmailPayloadSchema,
} from "../src/adapters/resend";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = z.object({
  ticket_id: z.string(),
  revision: z.number().int().min(1).max(4),
  proposal_hash: hash,
  proposal_json: z.string(),
  edit_reason: z.string().nullable(),
  edited_by: z.string().nullable(),
  created_at: z.string().datetime(),
});
const rowSchema = z.object({
  hubspot_ticket_id: z.string().regex(/^\d{1,20}$/),
  subject: z.string().startsWith("[TP-DEMO]"),
  state: z.literal("COMPLETED"),
  evidence_status: z.literal("SUPPORTED"),
  decision: z.literal("APPROVE"),
  decision_by: z.string(),
  proposal_revision: z.number().int().min(2).max(4),
  proposal_hash: hash,
  approved_payload_hash: hash,
  immutable_email_payload_json: z.string(),
  resend_attempts: z.literal(1),
  resend_message_id: z.string().min(1),
  hubspot_note_id: z.string().regex(/^\d+$/),
  crm_audit_status: z.literal("COMPLETED"),
  crm_audit_marker: z.string().min(1),
});

export async function verifyEditedLedger(
  rawRow: unknown,
  rawHistory: unknown,
  approver: string,
  recipient: string,
): Promise<{
  ticketId: string;
  revision: number;
  noteId: string;
  marker: string;
  receipt: string;
  noteFragments: string[];
}> {
  const row = rowSchema.parse(rawRow);
  const history = z.array(revisionSchema).min(2).max(4).parse(rawHistory);
  if (row.decision_by !== approver || history.length !== row.proposal_revision)
    throw new Error("edit_approval_mismatch");
  const drafts: string[] = [];
  const summaries: string[] = [];
  for (const [index, revision] of history.entries()) {
    const snapshot = z
      .object({
        revision: z.literal(index + 1),
        proposalHash: hash,
        draft_reply: z.string().min(1).max(1500),
        summary: z.string().min(1).max(240),
      })
      .parse(JSON.parse(revision.proposal_json));
    if (
      revision.ticket_id !== row.hubspot_ticket_id ||
      revision.revision !== index + 1 ||
      snapshot.proposalHash !== revision.proposal_hash
    )
      throw new Error("edit_history_mismatch");
    if (
      index === 0
        ? revision.edited_by !== null || revision.edit_reason !== null
        : revision.edited_by !== approver || !revision.edit_reason?.trim()
    )
      throw new Error("edit_provenance_mismatch");
    drafts.push(snapshot.draft_reply);
    summaries.push(snapshot.summary);
  }
  const payload = immutableEmailPayloadSchema.parse(JSON.parse(row.immutable_email_payload_json));
  if (
    history.at(-1)?.proposal_hash !== row.proposal_hash ||
    payload.to[0] !== recipient ||
    payload.text !== drafts.at(-1) ||
    payload.subject !== buildDemoEmailSubject(row.hubspot_ticket_id, row.subject) ||
    (await hashEmailPayload(payload)) !== row.approved_payload_hash
  )
    throw new Error("edited_payload_mismatch");
  if (payload.text === drafts[0]) throw new Error("changed_reply_required_for_live_demo");
  return {
    ticketId: row.hubspot_ticket_id,
    revision: row.proposal_revision,
    noteId: row.hubspot_note_id,
    marker: row.crm_audit_marker,
    receipt: row.resend_message_id,
    noteFragments: [
      `Approved/sent revision: ${row.proposal_revision}`,
      row.proposal_hash,
      row.approved_payload_hash,
      ...drafts,
      ...summaries,
      ...history.flatMap((item) => [item.proposal_hash, item.created_at]),
      ...history.flatMap((item) =>
        item.edit_reason === null ? [] : [item.edit_reason, item.edited_by ?? "", item.created_at],
      ),
    ],
  };
}

export function auditContainsEditedEvidence(
  rawBody: string,
  fragments: readonly string[],
): boolean {
  // Strip trusted presentation before decoding, preserving literal user angle brackets.
  const text = rawBody
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);|&apos;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\r\n/g, "\n");
  return fragments.every(
    (fragment) => fragment.length > 0 && text.includes(fragment.replace(/\r\n/g, "\n")),
  );
}
