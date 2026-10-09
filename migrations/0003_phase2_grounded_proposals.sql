ALTER TABLE tickets ADD COLUMN proposal_summary TEXT
  CHECK (proposal_summary IS NULL OR length(proposal_summary) <= 240);
ALTER TABLE tickets ADD COLUMN proposal_rationale TEXT
  CHECK (proposal_rationale IS NULL OR length(proposal_rationale) <= 300);
ALTER TABLE tickets ADD COLUMN policy_evidence_json TEXT
  CHECK (policy_evidence_json IS NULL OR json_valid(policy_evidence_json));
ALTER TABLE tickets ADD COLUMN prompt_version TEXT;
ALTER TABLE tickets ADD COLUMN ai_call_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (ai_call_attempts BETWEEN 0 AND 2);

ALTER TABLE daily_usage ADD COLUMN ai_call_count INTEGER NOT NULL DEFAULT 0
  CHECK (ai_call_count BETWEEN 0 AND 20);

CREATE TABLE ai_call_reservations (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (hubspot_ticket_id),
  utc_day TEXT NOT NULL REFERENCES daily_usage (utc_day),
  attempt_no INTEGER NOT NULL CHECK (attempt_no BETWEEN 1 AND 2),
  reserved_at TEXT NOT NULL,
  UNIQUE (ticket_id, attempt_no)
);

CREATE TABLE provider_rate_limits (
  name TEXT PRIMARY KEY,
  next_slot_ms INTEGER NOT NULL CHECK (next_slot_ms >= 0)
);

INSERT INTO provider_rate_limits (name, next_slot_ms) VALUES ('notion', 0)
  ON CONFLICT (name) DO NOTHING;

CREATE TRIGGER ai_call_reservation_guard
BEFORE INSERT ON ai_call_reservations
BEGIN
  SELECT RAISE(IGNORE) WHERE NOT EXISTS (
    SELECT 1 FROM tickets t
    JOIN daily_usage d ON d.utc_day = NEW.utc_day
    WHERE t.hubspot_ticket_id = NEW.ticket_id
      AND t.state = 'PROCESSING'
      AND t.proposal_hash IS NULL
      AND t.ai_call_attempts < 2
      AND NEW.attempt_no = t.ai_call_attempts + 1
      AND d.ai_call_count < 20
  );
END;

CREATE TRIGGER ai_call_reservation_apply
AFTER INSERT ON ai_call_reservations
BEGIN
  UPDATE tickets SET ai_call_attempts = ai_call_attempts + 1
  WHERE hubspot_ticket_id = NEW.ticket_id;
  UPDATE daily_usage SET ai_call_count = ai_call_count + 1
  WHERE utc_day = NEW.utc_day;
  INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
  VALUES (
    'ai-reservation-' || NEW.id,
    NEW.ticket_id,
    'AI_CALL_RESERVED',
    NEW.reserved_at,
    json_object('attempt', NEW.attempt_no, 'utc_day', NEW.utc_day)
  );
END;

CREATE TRIGGER tickets_proposal_immutable
BEFORE UPDATE OF proposal_hash, proposal_summary, proposal_rationale, category, priority,
  evidence_status, draft_reply, policy_keys_json, policy_evidence_json, prompt_version
ON tickets
WHEN OLD.proposal_hash IS NOT NULL AND (
  NEW.proposal_hash IS NOT OLD.proposal_hash OR
  NEW.proposal_summary IS NOT OLD.proposal_summary OR
  NEW.proposal_rationale IS NOT OLD.proposal_rationale OR
  NEW.category IS NOT OLD.category OR
  NEW.priority IS NOT OLD.priority OR
  NEW.evidence_status IS NOT OLD.evidence_status OR
  NEW.draft_reply IS NOT OLD.draft_reply OR
  NEW.policy_keys_json IS NOT OLD.policy_keys_json OR
  NEW.policy_evidence_json IS NOT OLD.policy_evidence_json OR
  NEW.prompt_version IS NOT OLD.prompt_version
)
BEGIN
  SELECT RAISE(ABORT, 'proposal is immutable');
END;
