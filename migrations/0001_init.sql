CREATE TABLE IF NOT EXISTS tickets (
  hubspot_ticket_id TEXT PRIMARY KEY,
  workflow_instance_id TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  hubspot_created_at TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (length(subject) <= 160),
  state TEXT NOT NULL CHECK (state IN (
    'DISCOVERED', 'PROCESSING', 'AWAITING_APPROVAL', 'APPROVED',
    'SEND_IN_PROGRESS', 'EMAIL_ACCEPTED', 'COMPLETED', 'REJECTED', 'EXPIRED',
    'NEEDS_MANUAL_REVIEW', 'RETRY_PENDING', 'SEND_FAILED', 'SEND_UNKNOWN',
    'EMAIL_ACCEPTED_PENDING_CRM_AUDIT'
  )),
  category TEXT CHECK (category IS NULL OR category IN ('BILLING', 'ACCESS', 'TECHNICAL', 'OTHER')),
  priority TEXT CHECK (priority IS NULL OR priority IN ('LOW', 'MEDIUM', 'HIGH')),
  evidence_status TEXT CHECK (
    evidence_status IS NULL OR evidence_status IN ('SUPPORTED', 'INSUFFICIENT_EVIDENCE')
  ),
  draft_reply TEXT CHECK (draft_reply IS NULL OR length(draft_reply) <= 1500),
  policy_keys_json TEXT CHECK (policy_keys_json IS NULL OR json_valid(policy_keys_json)),
  proposal_hash TEXT,
  proposal_revision INTEGER NOT NULL DEFAULT 1 CHECK (proposal_revision > 0),
  slack_channel TEXT,
  slack_message_ts TEXT,
  decision TEXT CHECK (decision IS NULL OR decision IN ('APPROVE', 'REJECT')),
  decision_by TEXT,
  decision_at TEXT,
  decision_event_pending INTEGER NOT NULL DEFAULT 0 CHECK (decision_event_pending IN (0, 1)),
  decision_event_delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (decision_event_delivery_attempts >= 0),
  decision_event_delivered_at TEXT,
  approved_payload_hash TEXT,
  immutable_email_payload_json TEXT
    CHECK (immutable_email_payload_json IS NULL OR json_valid(immutable_email_payload_json)),
  resend_idempotency_key TEXT,
  resend_message_id TEXT,
  hubspot_note_id TEXT,
  error_code TEXT,
  retries INTEGER NOT NULL DEFAULT 0 CHECK (retries >= 0),
  correlation_id TEXT,
  CHECK (
    (decision IS NULL AND decision_by IS NULL AND decision_at IS NULL) OR
    (decision IS NOT NULL AND decision_by IS NOT NULL AND decision_at IS NOT NULL)
  ),
  CHECK (
    decision IS NULL OR decision <> 'APPROVE' OR
    (evidence_status IS NOT NULL AND evidence_status = 'SUPPORTED')
  )
);

CREATE INDEX IF NOT EXISTS tickets_state_updated_at_idx ON tickets (state, updated_at);
CREATE INDEX IF NOT EXISTS tickets_decision_event_pending_idx
  ON tickets (decision_event_pending, decision_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (hubspot_ticket_id),
  event_type TEXT NOT NULL,
  at TEXT NOT NULL,
  details_redacted_json TEXT NOT NULL CHECK (json_valid(details_redacted_json))
);

CREATE INDEX IF NOT EXISTS events_ticket_at_idx ON events (ticket_id, at);

CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS tickets_email_payload_immutable
BEFORE UPDATE OF immutable_email_payload_json ON tickets
WHEN OLD.immutable_email_payload_json IS NOT NULL
  AND NEW.immutable_email_payload_json IS NOT OLD.immutable_email_payload_json
BEGIN
  SELECT RAISE(ABORT, 'approved email payload is immutable');
END;

CREATE TABLE IF NOT EXISTS daily_usage (
  utc_day TEXT PRIMARY KEY CHECK (utc_day GLOB '????-??-??'),
  accepted_ticket_count INTEGER NOT NULL DEFAULT 0
    CHECK (accepted_ticket_count >= 0 AND accepted_ticket_count <= 20)
);
