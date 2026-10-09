ALTER TABLE tickets ADD COLUMN slack_team_id TEXT;
ALTER TABLE tickets ADD COLUMN slack_post_status TEXT NOT NULL DEFAULT 'NOT_STARTED'
  CHECK (slack_post_status IN ('NOT_STARTED', 'IN_PROGRESS', 'POSTED', 'FAILED', 'UNKNOWN'));
ALTER TABLE tickets ADD COLUMN slack_post_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (slack_post_attempts BETWEEN 0 AND 1);
ALTER TABLE tickets ADD COLUMN slack_post_started_at TEXT;
ALTER TABLE tickets ADD COLUMN slack_review_started_at TEXT;
ALTER TABLE tickets ADD COLUMN slack_review_deadline TEXT;

CREATE INDEX tickets_slack_event_pending_idx ON tickets (
  decision_event_pending, decision_event_delivery_attempts, decision_at
);

CREATE TRIGGER tickets_slack_approval_requires_grounding
BEFORE UPDATE OF state ON tickets
WHEN NEW.state = 'APPROVED' AND (
  NEW.decision IS NOT 'APPROVE' OR
  NEW.evidence_status IS NOT 'SUPPORTED' OR
  NEW.draft_reply IS NULL OR length(trim(NEW.draft_reply)) = 0 OR
  NEW.policy_keys_json IS NULL OR json_array_length(NEW.policy_keys_json) = 0 OR
  NEW.policy_evidence_json IS NULL OR json_array_length(NEW.policy_evidence_json) = 0
)
BEGIN
  SELECT RAISE(ABORT, 'approval requires supported grounded proposal');
END;
