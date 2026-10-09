import { z } from "zod";

export const attestationSchema = z.object({
  source: z.enum(["interactive_owner_attestation", "owner_chat_confirmation"]),
  ticket_id: z.string().regex(/^\d{1,20}$/),
  resend_message_id: z.string().min(1).max(100),
  decision_at: z.string().min(1),
  recorded_at: z.iso.datetime(),
  physical_click_confirmed: z.literal(true),
  particular_message_inbox_confirmed: z.literal(true),
});

export function matchOwnerEvidence(
  raw: unknown,
  verifiedRows: readonly Record<string, unknown>[],
): z.infer<typeof attestationSchema>["source"] | null {
  const parsed = attestationSchema.safeParse(raw);
  if (!parsed.success) return null;
  const record = parsed.data;
  return verifiedRows.some(
    (row) =>
      row.hubspot_ticket_id === record.ticket_id &&
      row.resend_message_id === record.resend_message_id &&
      row.decision_at === record.decision_at,
  )
    ? record.source
    : null;
}
