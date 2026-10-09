import { z } from "zod";

export type EmailDeliveryRow = {
  hubspot_ticket_id: string;
  subject: string;
  state: string;
  evidence_status: string | null;
  proposal_hash: string | null;
  proposal_revision: number;
  category: string | null;
  priority: string | null;
  proposal_summary: string | null;
  policy_keys_json: string | null;
  decision: "APPROVE" | "REJECT" | null;
  decision_by: string | null;
  decision_at: string | null;
  slack_team_id: string | null;
  slack_channel: string | null;
  slack_message_ts: string | null;
  slack_post_status: string;
  slack_review_deadline: string | null;
  approved_payload_hash: string | null;
  immutable_email_payload_json: string | null;
  resend_idempotency_key: string | null;
  resend_message_id: string | null;
  resend_attempts: number;
  resend_first_attempt_at: string | null;
  resend_last_attempt_at: string | null;
  resend_retry_after: string | null;
  crm_audit_status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "UNKNOWN";
  crm_audit_started_at: string | null;
  crm_audit_attempts: number;
  crm_audit_lease_token: string | null;
  crm_audit_marker: string | null;
  crm_audit_candidate_note_id: string | null;
  hubspot_note_id: string | null;
};

export type PayloadIdentity = {
  payloadJson: string;
  payloadHash: string;
  idempotencyKey: string;
  recipientAlias: string;
};

const payloadIdentitySchema = z.object({
  payloadJson: z.string().min(1),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(1).max(256),
  recipientAlias: z.string().min(1).max(320),
});

export class EmailDeliveryRepository {
  constructor(private readonly db: D1Database) {}

  async get(ticketId: string): Promise<EmailDeliveryRow | null> {
    return this.db
      .prepare(`SELECT hubspot_ticket_id, subject, state, evidence_status, proposal_hash,
          proposal_revision, decision, decision_by, decision_at, slack_team_id,
          category, priority, proposal_summary, policy_keys_json,
          slack_channel, slack_message_ts, slack_post_status, slack_review_deadline,
          approved_payload_hash, immutable_email_payload_json, resend_idempotency_key,
          resend_message_id, resend_attempts, resend_first_attempt_at,
          resend_last_attempt_at, resend_retry_after, crm_audit_status,
          crm_audit_started_at, crm_audit_attempts, crm_audit_lease_token,
          crm_audit_marker, crm_audit_candidate_note_id, hubspot_note_id
        FROM tickets WHERE hubspot_ticket_id = ?`)
      .bind(ticketId)
      .first<EmailDeliveryRow>();
  }

  async listPendingCrmAudits(limit = 1): Promise<EmailDeliveryRow[]> {
    const boundedLimit = Math.max(0, Math.min(Math.trunc(limit), 1));
    if (boundedLimit === 0) return [];
    const result = await this.db
      .prepare(`SELECT hubspot_ticket_id, subject, state, evidence_status, proposal_hash,
          proposal_revision, category, priority, proposal_summary, policy_keys_json,
          decision, decision_by, decision_at, slack_team_id, slack_channel,
          slack_message_ts, slack_post_status, slack_review_deadline,
          approved_payload_hash, immutable_email_payload_json, resend_idempotency_key,
          resend_message_id, resend_attempts, resend_first_attempt_at,
          resend_last_attempt_at, resend_retry_after, crm_audit_status,
          crm_audit_started_at, crm_audit_attempts, crm_audit_lease_token,
          crm_audit_marker, crm_audit_candidate_note_id, hubspot_note_id
        FROM tickets WHERE state IN ('EMAIL_ACCEPTED', 'EMAIL_ACCEPTED_PENDING_CRM_AUDIT')
          AND resend_message_id IS NOT NULL AND hubspot_note_id IS NULL
          AND crm_audit_status <> 'COMPLETED'
        ORDER BY updated_at ASC, hubspot_ticket_id ASC LIMIT ?`)
      .bind(boundedLimit)
      .all<EmailDeliveryRow>();
    return result.results;
  }

  async reserveApprovedEmail(
    ticketId: string,
    expected: {
      proposalHash: string;
      proposalRevision: number;
      approverId: string;
      teamId: string;
      channelId: string;
    },
    identity: PayloadIdentity,
    now = new Date(),
  ): Promise<boolean> {
    const parsed = payloadIdentitySchema.safeParse(identity);
    if (!parsed.success || identity.idempotencyKey !== `ticketpilot/${ticketId}/v1`) return false;
    const marker = auditMarker(ticketId, identity.payloadHash);
    const at = now.toISOString();
    const updated = await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET state = 'SEND_IN_PROGRESS',
            approved_payload_hash = ?, immutable_email_payload_json = ?,
            resend_idempotency_key = ?, resend_attempts = 1,
            resend_first_attempt_at = ?, resend_last_attempt_at = ?,
            crm_audit_marker = ?, error_code = NULL, updated_at = ?
          WHERE hubspot_ticket_id = ? AND state = 'APPROVED'
            AND decision = 'APPROVE' AND decision_by = ?
            AND decision_at IS NOT NULL AND decision_at <= ?
            AND evidence_status = 'SUPPORTED' AND proposal_hash = ?
            AND proposal_revision = ? AND slack_team_id = ? AND slack_channel = ?
            AND slack_message_ts IS NOT NULL AND slack_post_status = 'POSTED'
            AND slack_review_deadline IS NOT NULL AND decision_at <= slack_review_deadline
            AND approved_payload_hash IS NULL AND immutable_email_payload_json IS NULL
            AND resend_idempotency_key IS NULL AND resend_attempts = 0`)
        .bind(
          identity.payloadHash,
          identity.payloadJson,
          identity.idempotencyKey,
          at,
          at,
          marker,
          at,
          ticketId,
          expected.approverId,
          at,
          expected.proposalHash,
          expected.proposalRevision,
          expected.teamId,
          expected.channelId,
        ),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, 'EMAIL_SEND_RESERVED', ?, ? WHERE changes() = 1
          ON CONFLICT (id) DO NOTHING`)
        .bind(
          `email-send-reserved-${ticketId}`,
          ticketId,
          at,
          JSON.stringify({
            payload_hash: identity.payloadHash,
            recipient_alias: identity.recipientAlias,
          }),
        ),
    ]);
    return (updated[0]?.meta.changes ?? 0) === 1;
  }

  async reserveRateLimitRetry(
    ticketId: string,
    expectedAttempt: number,
    now = new Date(),
  ): Promise<boolean> {
    if (!Number.isInteger(expectedAttempt) || expectedAttempt < 2 || expectedAttempt > 3)
      return false;
    const at = now.toISOString();
    const sendWindowCutoff = new Date(now.getTime() - 10 * 60 * 1_000).toISOString();
    const idempotencyCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
    const updated = await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET state = 'SEND_IN_PROGRESS',
            resend_attempts = resend_attempts + 1, resend_last_attempt_at = ?,
            resend_retry_after = NULL, error_code = NULL, updated_at = ?
          WHERE hubspot_ticket_id = ? AND state = 'RETRY_PENDING'
            AND resend_attempts = ? AND resend_attempts < 3
            AND resend_retry_after IS NOT NULL AND resend_retry_after <= ?
            AND resend_first_attempt_at IS NOT NULL
            AND resend_first_attempt_at >= ?
            AND resend_first_attempt_at >= ?`)
        .bind(at, at, ticketId, expectedAttempt - 1, at, sendWindowCutoff, idempotencyCutoff),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, 'EMAIL_SEND_RESERVED', ?, ? WHERE changes() = 1
          ON CONFLICT (id) DO NOTHING`)
        .bind(
          `email-send-reserved-${ticketId}-${expectedAttempt}`,
          ticketId,
          at,
          JSON.stringify({ attempt: expectedAttempt }),
        ),
    ]);
    return (updated[0]?.meta.changes ?? 0) === 1;
  }

  async failExpiredRateLimitRetry(
    ticketId: string,
    expectedAttempts: number,
    now = new Date(),
  ): Promise<boolean> {
    if (!Number.isInteger(expectedAttempts) || expectedAttempts < 1 || expectedAttempts >= 3)
      return false;
    const at = now.toISOString();
    const sendWindowCutoff = new Date(now.getTime() - 10 * 60 * 1_000).toISOString();
    const idempotencyCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET state = 'SEND_FAILED', resend_retry_after = NULL,
            error_code = 'RESEND_RETRY_WINDOW_EXPIRED', updated_at = ?
          WHERE hubspot_ticket_id = ? AND state = 'RETRY_PENDING'
            AND resend_attempts = ? AND (
              resend_first_attempt_at IS NULL OR resend_retry_after IS NULL OR
              julianday(resend_first_attempt_at) IS NULL OR
              julianday(resend_retry_after) IS NULL OR
              julianday(resend_retry_after) > julianday(resend_first_attempt_at, '+10 minutes') OR
              resend_first_attempt_at < ? OR resend_first_attempt_at < ?)`)
        .bind(at, ticketId, expectedAttempts, sendWindowCutoff, idempotencyCutoff),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, 'EMAIL_SEND_FAILED', ?, ? WHERE changes() = 1
          ON CONFLICT (id) DO NOTHING`)
        .bind(
          `email-retry-window-expired-${ticketId}-${expectedAttempts}`,
          ticketId,
          at,
          JSON.stringify({ attempt: expectedAttempts, code: "RESEND_RETRY_WINDOW_EXPIRED" }),
        ),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1;
  }

  async recordRateLimit(
    ticketId: string,
    expectedAttempt: number,
    retryAt: Date | null,
    now = new Date(),
  ): Promise<"retry_pending" | "failed"> {
    const at = now.toISOString();
    const retry = retryAt?.toISOString() ?? null;
    const row = await this.get(ticketId);
    if (
      row === null ||
      row.state !== "SEND_IN_PROGRESS" ||
      row.resend_attempts !== expectedAttempt
    ) {
      return "failed";
    }
    const firstAt =
      row.resend_first_attempt_at === null ? Number.NaN : Date.parse(row.resend_first_attempt_at);
    const retryAllowed =
      retry !== null &&
      Number.isFinite(firstAt) &&
      expectedAttempt < 3 &&
      Date.parse(retry) <= firstAt + 10 * 60 * 1_000 &&
      Date.parse(retry) <= now.getTime() + 10 * 60 * 1_000 &&
      firstAt >= now.getTime() - 24 * 60 * 60 * 1_000;
    const nextState = retryAllowed ? "RETRY_PENDING" : "SEND_FAILED";
    const eventType = retryAllowed ? "EMAIL_RATE_LIMITED" : "EMAIL_SEND_FAILED";
    const code = retryAllowed ? "RESEND_RATE_LIMITED" : "RESEND_RETRY_WINDOW_EXHAUSTED";
    await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET state = ?, resend_retry_after = ?, error_code = ?, updated_at = ?
          WHERE hubspot_ticket_id = ? AND state = 'SEND_IN_PROGRESS' AND resend_attempts = ?`)
        .bind(nextState, retryAllowed ? retry : null, code, at, ticketId, expectedAttempt),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT (id) DO NOTHING`)
        .bind(
          `email-rate-limit-${ticketId}-${expectedAttempt}`,
          ticketId,
          eventType,
          at,
          JSON.stringify({ attempt: expectedAttempt, retry_allowed: retryAllowed }),
        ),
    ]);
    return retryAllowed ? "retry_pending" : "failed";
  }

  async markSendUnknown(
    ticketId: string,
    expectedAttempt: number,
    now = new Date(),
  ): Promise<boolean> {
    return this.updateSendState(
      ticketId,
      expectedAttempt,
      "SEND_UNKNOWN",
      "RESEND_OUTCOME_UNKNOWN",
      "EMAIL_SEND_UNKNOWN",
      now,
    );
  }

  async markSendFailed(
    ticketId: string,
    expectedAttempt: number,
    now = new Date(),
  ): Promise<boolean> {
    return this.updateSendState(
      ticketId,
      expectedAttempt,
      "SEND_FAILED",
      "RESEND_DEFINITIVE_REJECTION",
      "EMAIL_SEND_FAILED",
      now,
    );
  }

  async recordAccepted(
    ticketId: string,
    expectedAttempt: number,
    messageId: string,
    now = new Date(),
  ): Promise<boolean> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(messageId)) return false;
    const at = now.toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET state = 'EMAIL_ACCEPTED', resend_message_id = ?,
            resend_retry_after = NULL, error_code = NULL, updated_at = ?
          WHERE hubspot_ticket_id = ? AND state = 'SEND_IN_PROGRESS'
            AND resend_attempts = ? AND resend_message_id IS NULL
            AND approved_payload_hash IS NOT NULL AND resend_idempotency_key IS NOT NULL`)
        .bind(messageId, at, ticketId, expectedAttempt),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, 'EMAIL_ACCEPTED', ?, ? WHERE changes() = 1
          ON CONFLICT (id) DO NOTHING`)
        .bind(
          `email-accepted-${ticketId}`,
          ticketId,
          at,
          JSON.stringify({ resend_message_id: messageId, attempt: expectedAttempt }),
        ),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1;
  }

  async beginCrmAuditCreate(
    ticketId: string,
    leaseToken: string,
    now = new Date(),
  ): Promise<boolean> {
    if (!/^[a-f0-9-]{36}$/i.test(leaseToken)) return false;
    const at = now.toISOString();
    const updated = await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET state = 'EMAIL_ACCEPTED_PENDING_CRM_AUDIT',
            crm_audit_status = 'IN_PROGRESS', crm_audit_started_at = ?,
            crm_audit_attempts = crm_audit_attempts + 1, crm_audit_lease_token = ?,
            updated_at = ?
          WHERE hubspot_ticket_id = ? AND resend_message_id IS NOT NULL
            AND state IN ('EMAIL_ACCEPTED', 'EMAIL_ACCEPTED_PENDING_CRM_AUDIT')
            AND crm_audit_status = 'NOT_STARTED' AND crm_audit_attempts < 3
            AND crm_audit_marker IS NOT NULL AND hubspot_note_id IS NULL`)
        .bind(at, leaseToken, at, ticketId),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, 'CRM_AUDIT_CREATE_RESERVED', ?, ? WHERE changes() = 1
          ON CONFLICT (id) DO NOTHING`)
        .bind(
          `crm-audit-create-reserved-${ticketId}-${leaseToken}`,
          ticketId,
          at,
          JSON.stringify({ lease_reserved: true }),
        ),
    ]);
    return (updated[0]?.meta.changes ?? 0) === 1;
  }

  async completeCrmAudit(ticketId: string, noteId: string, now = new Date()): Promise<boolean> {
    if (!/^\d+$/.test(noteId)) return false;
    const at = now.toISOString();
    const result = await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET state = 'COMPLETED', crm_audit_status = 'COMPLETED',
            hubspot_note_id = ?, crm_audit_lease_token = NULL, error_code = NULL, updated_at = ?
          WHERE hubspot_ticket_id = ? AND state IN ('EMAIL_ACCEPTED', 'EMAIL_ACCEPTED_PENDING_CRM_AUDIT')
            AND resend_message_id IS NOT NULL AND crm_audit_marker IS NOT NULL
            AND hubspot_note_id IS NULL AND crm_audit_status IN ('NOT_STARTED', 'IN_PROGRESS', 'UNKNOWN')`)
        .bind(noteId, at, ticketId),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, 'CRM_AUDIT_COMPLETED', ?, ? WHERE changes() = 1
          ON CONFLICT (id) DO NOTHING`)
        .bind(
          `crm-audit-completed-${ticketId}`,
          ticketId,
          at,
          JSON.stringify({ hubspot_note_id: noteId }),
        ),
    ]);
    return (result[0]?.meta.changes ?? 0) === 1;
  }

  async recordCrmAuditCandidate(
    ticketId: string,
    noteId: string,
    now = new Date(),
  ): Promise<boolean> {
    if (!/^\d+$/.test(noteId)) return false;
    const at = now.toISOString();
    const result = await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET crm_audit_candidate_note_id = ?, updated_at = ?
          WHERE hubspot_ticket_id = ? AND crm_audit_status = 'IN_PROGRESS'
            AND crm_audit_candidate_note_id IS NULL AND hubspot_note_id IS NULL
            AND resend_message_id IS NOT NULL`)
        .bind(noteId, at, ticketId),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, 'CRM_AUDIT_CANDIDATE_RECORDED', ?, ? WHERE changes() = 1
          ON CONFLICT (id) DO NOTHING`)
        .bind(
          `crm-audit-candidate-${ticketId}`,
          ticketId,
          at,
          JSON.stringify({ hubspot_note_id: noteId }),
        ),
    ]);
    return (result[0]?.meta.changes ?? 0) === 1;
  }

  async markCrmAuditUnknown(ticketId: string, now = new Date()): Promise<boolean> {
    return this.updateCrmAudit(ticketId, "UNKNOWN", "CRM_AUDIT_OUTCOME_UNKNOWN", now);
  }

  async markCrmAuditDefinitiveFailure(ticketId: string, now = new Date()): Promise<boolean> {
    return this.updateCrmAudit(ticketId, "NOT_STARTED", "CRM_AUDIT_RETRYABLE_FAILURE", now);
  }

  async markCrmAuditExhausted(ticketId: string, now = new Date()): Promise<boolean> {
    const at = now.toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET state = 'EMAIL_ACCEPTED_PENDING_CRM_AUDIT',
            crm_audit_status = 'UNKNOWN', error_code = 'CRM_AUDIT_ATTEMPTS_EXHAUSTED',
            crm_audit_lease_token = NULL, updated_at = ?
          WHERE hubspot_ticket_id = ? AND resend_message_id IS NOT NULL
            AND hubspot_note_id IS NULL AND crm_audit_attempts >= 3
            AND state IN ('EMAIL_ACCEPTED', 'EMAIL_ACCEPTED_PENDING_CRM_AUDIT')`)
        .bind(at, ticketId),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, 'CRM_AUDIT_ATTEMPTS_EXHAUSTED', ?, '{}'
          WHERE changes() = 1 ON CONFLICT (id) DO NOTHING`)
        .bind(`crm-audit-exhausted-${ticketId}`, ticketId, at),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1;
  }

  private async updateSendState(
    ticketId: string,
    expectedAttempt: number,
    state: "SEND_UNKNOWN" | "SEND_FAILED",
    errorCode: string,
    eventType: string,
    now: Date,
  ): Promise<boolean> {
    const at = now.toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET state = ?, error_code = ?, resend_retry_after = NULL,
            updated_at = ? WHERE hubspot_ticket_id = ? AND state = 'SEND_IN_PROGRESS'
            AND resend_attempts = ?`)
        .bind(state, errorCode, at, ticketId, expectedAttempt),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT (id) DO NOTHING`)
        .bind(
          `${eventType.toLowerCase()}-${ticketId}-${expectedAttempt}`,
          ticketId,
          eventType,
          at,
          JSON.stringify({ attempt: expectedAttempt, code: errorCode }),
        ),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1;
  }

  private async updateCrmAudit(
    ticketId: string,
    status: "NOT_STARTED" | "UNKNOWN",
    errorCode: string,
    now: Date,
  ): Promise<boolean> {
    const at = now.toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET state = 'EMAIL_ACCEPTED_PENDING_CRM_AUDIT',
            crm_audit_status = ?, crm_audit_lease_token = NULL,
            error_code = ?, updated_at = ?
          WHERE hubspot_ticket_id = ? AND state IN ('EMAIL_ACCEPTED', 'EMAIL_ACCEPTED_PENDING_CRM_AUDIT')
            AND resend_message_id IS NOT NULL AND hubspot_note_id IS NULL
            AND crm_audit_status IN ('IN_PROGRESS', 'UNKNOWN', 'NOT_STARTED')`)
        .bind(status, errorCode, at, ticketId),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT (id) DO NOTHING`)
        .bind(
          `${errorCode.toLowerCase()}-${ticketId}-${at}`,
          ticketId,
          status === "UNKNOWN" ? "CRM_AUDIT_OUTCOME_UNKNOWN" : "CRM_AUDIT_FAILED",
          at,
          JSON.stringify({ code: errorCode }),
        ),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1;
  }
}

export function auditMarker(ticketId: string, payloadHash: string): string {
  if (!/^\d+$/.test(ticketId) || !/^[a-f0-9]{64}$/.test(payloadHash)) {
    throw new Error("invalid_audit_marker_input");
  }
  return `[TICKETPILOT-AUDIT:${ticketId}:${payloadHash}]`;
}

export function maskRecipient(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "configured-owner";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}***@${domain}`;
}
