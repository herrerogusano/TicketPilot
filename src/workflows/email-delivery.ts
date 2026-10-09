import type { WorkflowStep } from "cloudflare:workers";
import { HubSpotClient, HubSpotError } from "../adapters/hubspot";
import {
  buildImmutableEmailPayload,
  hashEmailPayload,
  parseImmutableEmailPayload,
  ResendClient,
  type ResendSendResult,
} from "../adapters/resend";
import type { StoredProposal } from "../domain/contracts";
import {
  auditMarker,
  EmailDeliveryRepository,
  type EmailDeliveryRow,
  maskRecipient,
  type PayloadIdentity,
} from "../state/email-delivery";
import type { SlackReviewState } from "../state/ticket-repository";

const noRetryStep = {
  retries: { limit: 0, delay: 1_000, backoff: "constant" as const },
  timeout: 30_000,
};
const MAX_SEND_WINDOW_MS = 10 * 60 * 1_000;
const RESEND_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type DeliveryResult = {
  status:
    | "decision_received"
    | "email_accepted"
    | "completed"
    | "send_failed"
    | "send_unknown"
    | "crm_audit_pending"
    | "manual_review";
  decision?: "APPROVE" | "REJECT";
  evidence_status?: "SUPPORTED" | "INSUFFICIENT_EVIDENCE";
  cited_policy_keys?: string[];
};

export async function handleDurableDecision(
  step: WorkflowStep,
  env: Env,
  ticketId: string,
  proposal: StoredProposal,
  approval: SlackReviewState,
): Promise<DeliveryResult> {
  const result: DeliveryResult = {
    status: "decision_received",
    decision: approval.decision ?? undefined,
    evidence_status: proposal.evidence_status,
    cited_policy_keys: proposal.cited_policy_keys,
  };
  if (approval.decision !== "APPROVE") return result;
  if (!isApprovedContext(env, ticketId, proposal, approval)) return { status: "manual_review" };

  const repository = new EmailDeliveryRepository(env.DB);
  let row = await step.do<EmailDeliveryRow | null>("phase4-load-delivery-state", noRetryStep, () =>
    repository.get(ticketId),
  );
  if (row === null || !isApprovedDeliveryRow(env, ticketId, proposal, approval, row)) {
    return { status: "manual_review" };
  }

  if (row.state === "APPROVED") {
    const payload = buildImmutableEmailPayload(ticketId, proposal, env.TEST_RECIPIENT_EMAIL);
    const payloadHash = await step.do("phase4-hash-email-payload", noRetryStep, () =>
      hashEmailPayload(payload),
    );
    const identity: PayloadIdentity = {
      payloadJson: JSON.stringify(payload),
      payloadHash,
      idempotencyKey: `ticketpilot/${ticketId}/v1`,
      recipientAlias: maskRecipient(env.TEST_RECIPIENT_EMAIL),
    };
    const reserved = await step.do("phase4-reserve-email-send", noRetryStep, () =>
      repository.reserveApprovedEmail(
        ticketId,
        {
          proposalHash: proposal.proposalHash,
          proposalRevision: proposal.revision,
          approverId: env.SLACK_APPROVER_USER_ID,
          teamId: env.SLACK_TEAM_ID,
          channelId: env.SLACK_CHANNEL_ID,
        },
        identity,
      ),
    );
    if (!reserved) {
      row = await step.do("phase4-reconcile-email-reservation", noRetryStep, () =>
        repository.get(ticketId),
      );
      if (row === null) return { status: "manual_review" };
    }
    if (reserved) {
      row = await step.do("phase4-read-email-reservation", noRetryStep, () =>
        repository.get(ticketId),
      );
      if (row === null) return { status: "manual_review" };
      return sendReservedEmail(step, env, ticketId, row, repository);
    }
  }

  if (row.state === "RETRY_PENDING")
    return retryRateLimitedEmail(step, env, ticketId, row, repository);
  if (row.state === "EMAIL_ACCEPTED" || row.state === "EMAIL_ACCEPTED_PENDING_CRM_AUDIT") {
    return reconcileCrmAudit(step, env, ticketId, row, repository);
  }
  if (row.state === "COMPLETED") return { ...result, status: "completed" };
  if (row.state === "SEND_UNKNOWN") return { ...result, status: "send_unknown" };
  if (row.state === "SEND_FAILED") return { ...result, status: "send_failed" };
  // Another execution owns an active send or audit reservation. Never duplicate its side effect.
  if (row.state === "SEND_IN_PROGRESS") return { ...result, status: "manual_review" };
  return { ...result, status: "manual_review" };
}

async function retryRateLimitedEmail(
  step: WorkflowStep,
  env: Env,
  ticketId: string,
  initial: EmailDeliveryRow,
  repository: EmailDeliveryRepository,
): Promise<DeliveryResult> {
  let row = initial;
  const attempt = row.resend_attempts + 1;
  while (row.state === "RETRY_PENDING" && attempt <= 3) {
    const firstAttemptAt =
      row.resend_first_attempt_at === null ? Number.NaN : Date.parse(row.resend_first_attempt_at);
    if (row.resend_retry_after === null || !Number.isFinite(firstAttemptAt)) {
      await step.do(`phase4-fail-invalid-retry-window-${attempt}`, noRetryStep, () =>
        repository.failExpiredRateLimitRetry(ticketId, row.resend_attempts),
      );
      return { status: "send_failed" };
    }
    const waitMs = Date.parse(row.resend_retry_after) - Date.now();
    const firstAttemptAge = Date.now() - firstAttemptAt;
    if (
      !Number.isFinite(waitMs) ||
      firstAttemptAge >= MAX_SEND_WINDOW_MS ||
      firstAttemptAge >= RESEND_IDEMPOTENCY_WINDOW_MS ||
      waitMs > MAX_SEND_WINDOW_MS
    ) {
      await step.do(`phase4-fail-expired-retry-window-${attempt}`, noRetryStep, () =>
        repository.failExpiredRateLimitRetry(ticketId, row.resend_attempts),
      );
      return { status: "send_failed" };
    }
    if (waitMs > 0) {
      await step.sleep(
        `phase4-wait-resend-rate-limit-${attempt}`,
        `${Math.max(1, Math.ceil(waitMs / 1_000))} seconds`,
      );
    }
    const reserved = await step.do<boolean>(
      `phase4-reserve-rate-limit-retry-${attempt}`,
      noRetryStep,
      () => repository.reserveRateLimitRetry(ticketId, attempt),
    );
    if (!reserved) {
      const winner = await step.do(`phase4-load-rate-limit-winner-${attempt}`, noRetryStep, () =>
        repository.get(ticketId),
      );
      if (winner === null) return { status: "manual_review" };
      row = winner;
      if (row?.state === "EMAIL_ACCEPTED" || row?.state === "EMAIL_ACCEPTED_PENDING_CRM_AUDIT") {
        return reconcileCrmAudit(step, env, ticketId, row, repository);
      }
      if (row?.state === "SEND_UNKNOWN") return { status: "send_unknown" };
      if (row?.state === "SEND_FAILED") return { status: "send_failed" };
      if (row?.state === "RETRY_PENDING") {
        await step.do(`phase4-fail-raced-expired-window-${attempt}`, noRetryStep, () =>
          repository.failExpiredRateLimitRetry(ticketId, row.resend_attempts),
        );
        const afterExpiry = await step.do(
          `phase4-read-raced-expired-window-${attempt}`,
          noRetryStep,
          () => repository.get(ticketId),
        );
        if (afterExpiry?.state === "SEND_FAILED") return { status: "send_failed" };
      }
      return { status: "manual_review" };
    }
    const reservedRow = await step.do(
      `phase4-load-rate-limit-reservation-${attempt}`,
      noRetryStep,
      () => repository.get(ticketId),
    );
    if (reservedRow === null) return { status: "manual_review" };
    row = reservedRow;
    return sendReservedEmail(step, env, ticketId, row, repository);
  }
  return { status: row.state === "SEND_FAILED" ? "send_failed" : "manual_review" };
}

async function sendReservedEmail(
  step: WorkflowStep,
  env: Env,
  ticketId: string,
  row: EmailDeliveryRow,
  repository: EmailDeliveryRepository,
): Promise<DeliveryResult> {
  if (
    row.state !== "SEND_IN_PROGRESS" ||
    row.resend_idempotency_key !== `ticketpilot/${ticketId}/v1` ||
    row.immutable_email_payload_json === null ||
    row.approved_payload_hash === null ||
    row.resend_attempts < 1 ||
    row.resend_first_attempt_at === null
  ) {
    return { status: "manual_review" };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.immutable_email_payload_json) as unknown;
  } catch {
    await step.do("phase4-mark-corrupt-payload-unknown", noRetryStep, () =>
      repository.markSendUnknown(ticketId, row.resend_attempts),
    );
    return { status: "send_unknown" };
  }
  const payload = parseImmutableEmailPayload(decoded);
  if (
    payload === null ||
    payload.to[0] !== env.TEST_RECIPIENT_EMAIL ||
    payload.subject !== `[TicketPilot DEMO] Ticket ${ticketId} — Response`
  ) {
    await step.do("phase4-mark-invalid-payload-unknown", noRetryStep, () =>
      repository.markSendUnknown(ticketId, row.resend_attempts),
    );
    return { status: "send_unknown" };
  }
  const actualHash = await step.do("phase4-verify-payload-hash", noRetryStep, () =>
    hashEmailPayload(payload),
  );
  if (actualHash !== row.approved_payload_hash) {
    await step.do("phase4-mark-payload-hash-mismatch", noRetryStep, () =>
      repository.markSendUnknown(ticketId, row.resend_attempts),
    );
    return { status: "send_unknown" };
  }

  type SendOutcome = ResendSendResult | { kind: "already_recorded" };
  const outcome = await step.do<SendOutcome>(
    `phase4-resend-send-${row.resend_attempts}`,
    noRetryStep,
    async () => {
      const current = await repository.get(ticketId);
      if (current === null) return { kind: "unknown" };
      if (current.state === "EMAIL_ACCEPTED") return { kind: "already_recorded" };
      if (current.state !== "SEND_IN_PROGRESS" || current.resend_attempts !== row.resend_attempts) {
        return { kind: "unknown" };
      }
      const firstAt =
        current.resend_first_attempt_at === null
          ? Number.NaN
          : Date.parse(current.resend_first_attempt_at);
      const ageMs = Date.now() - firstAt;
      if (
        !Number.isFinite(firstAt) ||
        ageMs < 0 ||
        ageMs >= RESEND_IDEMPOTENCY_WINDOW_MS ||
        (row.resend_attempts > 1 && ageMs > MAX_SEND_WINDOW_MS)
      ) {
        await repository.markSendUnknown(ticketId, row.resend_attempts);
        return { kind: "unknown" };
      }
      const response = await new ResendClient(env.RESEND_API_KEY).send(
        payload,
        current.resend_idempotency_key ?? "",
      );
      if (response.kind === "accepted") {
        const recorded = await repository.recordAccepted(
          ticketId,
          row.resend_attempts,
          response.messageId,
        );
        if (recorded) return response;
        const winner = await repository.get(ticketId);
        if (winner?.state === "EMAIL_ACCEPTED" && winner.resend_message_id === response.messageId) {
          return response;
        }
        await repository.markSendUnknown(ticketId, row.resend_attempts);
        return { kind: "unknown" };
      }
      if (response.kind === "rate_limited") {
        const retryAfterMs = response.retryAfterMs;
        const retryAt = retryAfterMs === null ? null : new Date(Date.now() + retryAfterMs);
        await repository.recordRateLimit(ticketId, row.resend_attempts, retryAt);
        return response;
      }
      if (response.kind === "rejected") {
        await repository.markSendFailed(ticketId, row.resend_attempts);
        return response;
      }
      await repository.markSendUnknown(ticketId, row.resend_attempts);
      return response;
    },
  );

  if (outcome.kind === "accepted" || outcome.kind === "already_recorded") {
    const accepted = await step.do("phase4-confirm-email-accepted", noRetryStep, () =>
      repository.get(ticketId),
    );
    if (accepted === null || accepted.resend_message_id === null) return { status: "send_unknown" };
    return reconcileCrmAudit(step, env, ticketId, accepted, repository);
  }
  if (outcome.kind === "rate_limited") {
    const afterRateLimit = await step.do(
      `phase4-read-rate-limit-result-${row.resend_attempts}`,
      noRetryStep,
      () => repository.get(ticketId),
    );
    if (afterRateLimit?.state === "RETRY_PENDING") {
      return retryRateLimitedEmail(step, env, ticketId, afterRateLimit, repository);
    }
    return { status: "send_failed" };
  }
  return outcome.kind === "rejected" ? { status: "send_failed" } : { status: "send_unknown" };
}

async function reconcileCrmAudit(
  step: WorkflowStep,
  env: Env,
  ticketId: string,
  initial: EmailDeliveryRow,
  repository: EmailDeliveryRepository,
): Promise<DeliveryResult> {
  const row = initial;
  if (row.state === "COMPLETED" && row.hubspot_note_id !== null) return { status: "completed" };
  if (row.resend_message_id === null || row.crm_audit_marker === null) {
    return { status: "crm_audit_pending" };
  }

  const result = await step.do<AuditResult>("phase4-reconcile-crm-audit", noRetryStep, () =>
    reconcileCrmAuditOnce(env, ticketId, repository),
  );
  if (result.status === "completed") return { status: "completed" };
  const finalRow = await step.do("phase4-load-audit-outcome", noRetryStep, () =>
    repository.get(ticketId),
  );
  if (finalRow?.state === "COMPLETED") return { status: "completed" };
  return { status: "crm_audit_pending" };
}

type AuditResult = { status: "completed"; noteId: string } | { status: "pending" };

export async function reconcilePendingCrmAudits(
  env: Env,
): Promise<{ inspected: number; completed: number }> {
  const repository = new EmailDeliveryRepository(env.DB);
  const pending = await repository.listPendingCrmAudits(1);
  let completed = 0;
  for (const row of pending) {
    const result = await reconcileCrmAuditOnce(env, row.hubspot_ticket_id, repository);
    if (result.status === "completed") completed += 1;
  }
  return { inspected: pending.length, completed };
}

async function reconcileCrmAuditOnce(
  env: Env,
  ticketId: string,
  repository: EmailDeliveryRepository,
): Promise<AuditResult> {
  const current = await repository.get(ticketId);
  if (current === null || current.resend_message_id === null || current.crm_audit_marker === null) {
    return { status: "pending" };
  }
  if (current.state === "COMPLETED" && current.hubspot_note_id !== null) {
    return { status: "completed", noteId: current.hubspot_note_id };
  }

  const hubspot = new HubSpotClient(env.HUBSPOT_SERVICE_KEY);
  if (current.crm_audit_candidate_note_id !== null) {
    try {
      const verified = await hubspot.verifyAssociatedNote(
        ticketId,
        current.crm_audit_candidate_note_id,
        current.crm_audit_marker,
      );
      if (verified) {
        await repository.completeCrmAudit(ticketId, current.crm_audit_candidate_note_id);
        return { status: "completed", noteId: current.crm_audit_candidate_note_id };
      }
      const associated = await hubspot.findAssociatedNote(ticketId, current.crm_audit_marker);
      if (associated === current.crm_audit_candidate_note_id) {
        await repository.completeCrmAudit(ticketId, associated);
        return { status: "completed", noteId: associated };
      }
    } catch {
      await repository.markCrmAuditUnknown(ticketId);
    }
    // A recorded candidate is reconciled read-only; its create call is never repeated.
    return { status: "pending" };
  }

  let existingNoteId: string | null;
  try {
    existingNoteId = await hubspot.findAssociatedNote(ticketId, current.crm_audit_marker);
  } catch {
    await repository.markCrmAuditUnknown(ticketId);
    return { status: "pending" };
  }
  if (existingNoteId !== null) {
    await repository.completeCrmAudit(ticketId, existingNoteId);
    return { status: "completed", noteId: existingNoteId };
  }

  // A prior create reservation means its outcome may be ambiguous. Only read/reconcile it.
  if (current.crm_audit_status !== "NOT_STARTED") return { status: "pending" };
  if (current.crm_audit_attempts >= 3) {
    await repository.markCrmAuditExhausted(ticketId);
    return { status: "pending" };
  }
  const leaseToken = crypto.randomUUID();
  const reserved = await repository.beginCrmAuditCreate(ticketId, leaseToken);
  if (!reserved) return { status: "pending" };

  let noteBody: string;
  try {
    noteBody = buildAuditNote(current, env.TEST_RECIPIENT_EMAIL);
  } catch {
    await repository.markCrmAuditUnknown(ticketId);
    return { status: "pending" };
  }
  let createdId: string;
  try {
    createdId = await hubspot.createNote(ticketId, noteBody);
  } catch (error) {
    if (isRetryableHubSpotWriteFailure(error)) {
      await repository.markCrmAuditDefinitiveFailure(ticketId);
    } else {
      await repository.markCrmAuditUnknown(ticketId);
    }
    return { status: "pending" };
  }

  const candidateRecorded = await repository.recordCrmAuditCandidate(ticketId, createdId);
  if (!candidateRecorded) {
    const afterCandidate = await repository.get(ticketId);
    if (afterCandidate?.crm_audit_candidate_note_id !== createdId) {
      await repository.markCrmAuditUnknown(ticketId);
      return { status: "pending" };
    }
  }
  try {
    const verified = await hubspot.verifyAssociatedNote(
      ticketId,
      createdId,
      current.crm_audit_marker,
    );
    if (verified) {
      await repository.completeCrmAudit(ticketId, createdId);
      return { status: "completed", noteId: createdId };
    }
    await repository.markCrmAuditUnknown(ticketId);
    return { status: "pending" };
  } catch {
    await repository.markCrmAuditUnknown(ticketId);
    return { status: "pending" };
  }
}

function isApprovedContext(
  env: Env,
  ticketId: string,
  proposal: StoredProposal,
  approval: SlackReviewState,
): boolean {
  return (
    proposal.evidence_status === "SUPPORTED" &&
    proposal.cited_policy_keys.length > 0 &&
    proposal.policyEvidence.length > 0 &&
    approval.hubspot_ticket_id === ticketId &&
    [
      "APPROVED",
      "SEND_IN_PROGRESS",
      "RETRY_PENDING",
      "SEND_UNKNOWN",
      "SEND_FAILED",
      "EMAIL_ACCEPTED",
      "EMAIL_ACCEPTED_PENDING_CRM_AUDIT",
      "COMPLETED",
    ].includes(approval.state) &&
    approval.decision === "APPROVE" &&
    approval.decision_by === env.SLACK_APPROVER_USER_ID &&
    approval.decision_at !== null &&
    Number.isFinite(Date.parse(approval.decision_at)) &&
    approval.proposal_hash === proposal.proposalHash &&
    approval.proposal_revision === proposal.revision &&
    approval.evidence_status === "SUPPORTED" &&
    approval.slack_post_status === "POSTED" &&
    approval.slack_team_id === env.SLACK_TEAM_ID &&
    approval.slack_channel === env.SLACK_CHANNEL_ID &&
    approval.slack_message_ts !== null &&
    approval.slack_review_deadline !== null &&
    Date.parse(approval.decision_at) <= Date.parse(approval.slack_review_deadline)
  );
}

function isApprovedDeliveryRow(
  env: Env,
  ticketId: string,
  proposal: StoredProposal,
  approval: SlackReviewState,
  row: EmailDeliveryRow,
): boolean {
  return (
    row.hubspot_ticket_id === ticketId &&
    row.evidence_status === "SUPPORTED" &&
    row.proposal_hash === proposal.proposalHash &&
    row.proposal_revision === proposal.revision &&
    row.decision === "APPROVE" &&
    row.decision_by === env.SLACK_APPROVER_USER_ID &&
    row.decision_at === approval.decision_at &&
    row.slack_team_id === env.SLACK_TEAM_ID &&
    row.slack_channel === env.SLACK_CHANNEL_ID &&
    row.slack_message_ts === approval.slack_message_ts &&
    row.slack_post_status === "POSTED"
  );
}

function isRetryableHubSpotWriteFailure(error: unknown): boolean {
  if (!(error instanceof HubSpotError)) return false;
  return error.status === 429;
}

export function buildAuditNote(row: EmailDeliveryRow, recipient: string): string {
  if (
    row.crm_audit_marker === null ||
    row.hubspot_ticket_id === "" ||
    row.resend_message_id === null ||
    row.decision_by === null
  ) {
    throw new Error("audit_context_incomplete");
  }
  const payload = parseImmutableEmailPayload(
    row.immutable_email_payload_json === null ? null : JSON.parse(row.immutable_email_payload_json),
  );
  if (payload === null || payload.to[0] !== recipient) throw new Error("audit_payload_invalid");
  const marker = auditMarker(row.hubspot_ticket_id, row.approved_payload_hash ?? "");
  if (marker !== row.crm_audit_marker) throw new Error("audit_marker_mismatch");
  const details = [
    row.crm_audit_marker,
    "TicketPilot demo outbound audit (provider acceptance; not inbox delivery).",
    `Created at: ${row.decision_at ?? "unknown"}`,
    `Category: ${row.category ?? "unknown"}`,
    `Priority: ${row.priority ?? "unknown"}`,
    `Policy keys: ${safePolicyKeys(row.policy_keys_json)}`,
    `Approval actor: ${row.decision_by}`,
    `Recipient: ${maskRecipient(recipient)}`,
    `Resend message ID: ${row.resend_message_id}`,
    `Email subject: ${payload.subject}`,
    `Approved payload SHA-256: ${row.approved_payload_hash}`,
    `Proposal summary: ${(row.proposal_summary ?? "").slice(0, 240)}`,
  ];
  return details.join("\n").slice(0, 2_000);
}

function safePolicyKeys(value: string | null): string {
  if (value === null) return "unavailable";
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length <= 3 &&
      parsed.every((item) => typeof item === "string")
    ) {
      return parsed.join(", ");
    }
  } catch {
    return "unavailable";
  }
  return "unavailable";
}
