ALTER TABLE tickets ADD COLUMN resend_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (resend_attempts BETWEEN 0 AND 3);
ALTER TABLE tickets ADD COLUMN resend_first_attempt_at TEXT;
ALTER TABLE tickets ADD COLUMN resend_last_attempt_at TEXT;
ALTER TABLE tickets ADD COLUMN resend_retry_after TEXT;
ALTER TABLE tickets ADD COLUMN crm_audit_status TEXT NOT NULL DEFAULT 'NOT_STARTED'
  CHECK (crm_audit_status IN ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'UNKNOWN'));
ALTER TABLE tickets ADD COLUMN crm_audit_started_at TEXT;
ALTER TABLE tickets ADD COLUMN crm_audit_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (crm_audit_attempts BETWEEN 0 AND 3);
ALTER TABLE tickets ADD COLUMN crm_audit_lease_token TEXT;
ALTER TABLE tickets ADD COLUMN crm_audit_marker TEXT;
ALTER TABLE tickets ADD COLUMN crm_audit_candidate_note_id TEXT;

CREATE INDEX tickets_delivery_recovery_idx ON tickets (state, crm_audit_status, updated_at);

CREATE TRIGGER tickets_approved_email_requires_valid_approval
BEFORE UPDATE OF state ON tickets
WHEN NEW.state = 'SEND_IN_PROGRESS' AND (
  NEW.decision IS NOT 'APPROVE' OR
  NEW.evidence_status IS NOT 'SUPPORTED' OR
  NEW.proposal_hash IS NULL OR
  NEW.proposal_revision < 1 OR
  NEW.decision_by IS NULL OR
  NEW.decision_at IS NULL OR
  NEW.slack_team_id IS NULL OR
  NEW.slack_channel IS NULL OR
  NEW.slack_message_ts IS NULL OR
  NEW.slack_post_status IS NOT 'POSTED' OR
  NEW.approved_payload_hash IS NULL OR
  NEW.immutable_email_payload_json IS NULL OR
  NEW.resend_idempotency_key IS NULL OR
  NEW.resend_idempotency_key <> ('ticketpilot/' || NEW.hubspot_ticket_id || '/v1')
)
BEGIN
  SELECT RAISE(ABORT, 'email send requires durable approved supported proposal');
END;

CREATE TRIGGER tickets_resend_identity_immutable
BEFORE UPDATE OF approved_payload_hash, resend_idempotency_key ON tickets
WHEN (OLD.approved_payload_hash IS NOT NULL AND
      NEW.approved_payload_hash IS NOT OLD.approved_payload_hash) OR
     (OLD.resend_idempotency_key IS NOT NULL AND
      NEW.resend_idempotency_key IS NOT OLD.resend_idempotency_key)
BEGIN
  SELECT RAISE(ABORT, 'resend request identity is immutable');
END;

CREATE TRIGGER tickets_email_receipt_requires_in_progress
BEFORE UPDATE OF resend_message_id ON tickets
WHEN NEW.resend_message_id IS NOT NULL AND OLD.resend_message_id IS NULL AND
     OLD.state IS NOT 'SEND_IN_PROGRESS'
BEGIN
  SELECT RAISE(ABORT, 'email receipt requires an in-progress send');
END;

CREATE TRIGGER tickets_crm_audit_requires_accepted_email
BEFORE UPDATE OF crm_audit_status ON tickets
WHEN NEW.crm_audit_status <> 'NOT_STARTED' AND (
  NEW.resend_message_id IS NULL OR
  NEW.state NOT IN ('EMAIL_ACCEPTED', 'EMAIL_ACCEPTED_PENDING_CRM_AUDIT', 'COMPLETED')
)
BEGIN
  SELECT RAISE(ABORT, 'CRM audit requires accepted email');
END;

CREATE TRIGGER tickets_crm_audit_candidate_requires_reservation
BEFORE UPDATE OF crm_audit_candidate_note_id ON tickets
WHEN NEW.crm_audit_candidate_note_id IS NOT NULL AND (
  NEW.crm_audit_status IS NOT 'IN_PROGRESS' OR
  OLD.crm_audit_status IS NOT 'IN_PROGRESS' OR
  NEW.resend_message_id IS NULL OR
  OLD.crm_audit_candidate_note_id IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'CRM audit candidate requires active reservation');
END;

CREATE TRIGGER tickets_crm_audit_candidate_immutable
BEFORE UPDATE OF crm_audit_candidate_note_id ON tickets
WHEN OLD.crm_audit_candidate_note_id IS NOT NULL AND
     NEW.crm_audit_candidate_note_id IS NOT OLD.crm_audit_candidate_note_id
BEGIN
  SELECT RAISE(ABORT, 'CRM audit candidate is immutable');
END;
