CREATE TABLE proposal_revisions (
  ticket_id TEXT NOT NULL REFERENCES tickets (hubspot_ticket_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  proposal_hash TEXT NOT NULL CHECK (length(proposal_hash) = 64),
  proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json)),
  edit_reason TEXT,
  edited_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, revision)
);

CREATE TRIGGER proposal_revisions_no_update
BEFORE UPDATE ON proposal_revisions
BEGIN
  SELECT RAISE(ABORT, 'proposal revisions are append-only');
END;

CREATE TRIGGER proposal_revisions_no_delete
BEFORE DELETE ON proposal_revisions
BEGIN
  SELECT RAISE(ABORT, 'proposal revisions are append-only');
END;

CREATE INDEX proposal_revisions_ticket_created_idx
  ON proposal_revisions (ticket_id, created_at, revision);

ALTER TABLE tickets ADD COLUMN slack_refresh_revision INTEGER;
ALTER TABLE tickets ADD COLUMN slack_refresh_token TEXT;
ALTER TABLE tickets ADD COLUMN slack_refresh_locked_until TEXT;

INSERT INTO proposal_revisions (
  ticket_id, revision, proposal_hash, proposal_json, edit_reason, edited_by, created_at
)
SELECT hubspot_ticket_id, proposal_revision, proposal_hash,
  json_object(
    'category', category,
    'priority', priority,
    'evidence_status', evidence_status,
    'summary', proposal_summary,
    'draft_reply', draft_reply,
    'cited_policy_keys', json(policy_keys_json),
    'rationale', proposal_rationale,
    'proposalHash', proposal_hash,
    'revision', proposal_revision,
    'promptVersion', prompt_version,
    'policyEvidence', json(policy_evidence_json)
  ), NULL, NULL, updated_at
FROM tickets WHERE proposal_hash IS NOT NULL;

DROP TRIGGER tickets_proposal_immutable;
CREATE TRIGGER tickets_proposal_immutable
BEFORE UPDATE OF proposal_hash, proposal_revision, proposal_summary, proposal_rationale,
  category, priority, evidence_status, draft_reply, policy_keys_json,
  policy_evidence_json, prompt_version ON tickets
WHEN OLD.proposal_hash IS NOT NULL AND (
  NEW.proposal_rationale IS NOT OLD.proposal_rationale OR
  NEW.category IS NOT OLD.category OR
  NEW.priority IS NOT OLD.priority OR
  NEW.evidence_status IS NOT OLD.evidence_status OR
  NEW.policy_keys_json IS NOT OLD.policy_keys_json OR
  NEW.policy_evidence_json IS NOT OLD.policy_evidence_json OR
  NEW.prompt_version IS NOT OLD.prompt_version OR
  (
    (NEW.proposal_hash IS NOT OLD.proposal_hash OR
     NEW.proposal_revision IS NOT OLD.proposal_revision OR
     NEW.proposal_summary IS NOT OLD.proposal_summary OR
     NEW.draft_reply IS NOT OLD.draft_reply) AND
    (
      OLD.state IS NOT 'AWAITING_APPROVAL' OR NEW.state IS NOT 'AWAITING_APPROVAL' OR
      OLD.decision IS NOT NULL OR NEW.decision IS NOT NULL OR
      OLD.approved_payload_hash IS NOT NULL OR NEW.approved_payload_hash IS NOT NULL OR
      OLD.slack_post_status IS NOT 'POSTED' OR NEW.slack_post_status IS NOT 'POSTED' OR
      OLD.slack_review_deadline IS NULL OR
      OLD.slack_review_deadline <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') OR
      NEW.proposal_revision <> OLD.proposal_revision + 1 OR
      NEW.slack_refresh_revision IS NOT NEW.proposal_revision OR
      NOT EXISTS (
        SELECT 1 FROM proposal_revisions r
        WHERE r.ticket_id = NEW.hubspot_ticket_id
          AND r.revision = NEW.proposal_revision
          AND r.proposal_hash = NEW.proposal_hash
          AND json_extract(r.proposal_json, '$.draft_reply') IS NEW.draft_reply
          AND json_extract(r.proposal_json, '$.summary') IS NEW.proposal_summary
      )
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'proposal is immutable outside pending human revisions');
END;

CREATE TRIGGER proposal_revisions_insert_guard
BEFORE INSERT ON proposal_revisions
WHEN NOT (
  (NEW.revision = 1 AND NEW.edit_reason IS NULL AND NEW.edited_by IS NULL AND EXISTS (
    SELECT 1 FROM tickets t WHERE t.hubspot_ticket_id = NEW.ticket_id
      AND t.proposal_revision = 1 AND t.proposal_hash = NEW.proposal_hash
      AND json_extract(NEW.proposal_json, '$.draft_reply') IS t.draft_reply
      AND json_extract(NEW.proposal_json, '$.summary') IS t.proposal_summary
  )) OR
  (NEW.revision > 1 AND length(trim(NEW.edit_reason)) BETWEEN 1 AND 200
    AND NEW.edited_by IS NOT NULL AND EXISTS (
      SELECT 1 FROM tickets t WHERE t.hubspot_ticket_id = NEW.ticket_id
        AND t.state = 'AWAITING_APPROVAL' AND t.decision IS NULL
        AND t.approved_payload_hash IS NULL AND t.slack_post_status = 'POSTED'
        AND t.proposal_revision = NEW.revision - 1
        AND t.proposal_hash IS NOT NULL
        AND t.slack_refresh_revision IS NULL
        AND t.slack_review_deadline > NEW.created_at
        AND NEW.revision <= 4
        AND json_extract(NEW.proposal_json, '$.draft_reply') IS NOT NULL
        AND length(json_extract(NEW.proposal_json, '$.draft_reply')) BETWEEN 1 AND 1500
        AND json_extract(NEW.proposal_json, '$.summary') IS NOT NULL
        AND length(json_extract(NEW.proposal_json, '$.summary')) <= 240
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'proposal revision is not an authorized pending human edit');
END;

CREATE TRIGGER tickets_capture_initial_proposal_after_insert
AFTER INSERT ON tickets
WHEN NEW.proposal_hash IS NOT NULL
BEGIN
  INSERT INTO proposal_revisions (
    ticket_id, revision, proposal_hash, proposal_json, edit_reason, edited_by, created_at
  ) VALUES (
    NEW.hubspot_ticket_id, NEW.proposal_revision, NEW.proposal_hash,
    json_object(
      'category', NEW.category,
      'priority', NEW.priority,
      'evidence_status', NEW.evidence_status,
      'summary', NEW.proposal_summary,
      'draft_reply', NEW.draft_reply,
      'cited_policy_keys', json(NEW.policy_keys_json),
      'rationale', NEW.proposal_rationale,
      'proposalHash', NEW.proposal_hash,
      'revision', NEW.proposal_revision,
      'promptVersion', NEW.prompt_version,
      'policyEvidence', json(NEW.policy_evidence_json)
    ), NULL, NULL, NEW.updated_at
  ) ON CONFLICT (ticket_id, revision) DO NOTHING;
END;

CREATE TRIGGER tickets_capture_initial_proposal_after_update
AFTER UPDATE OF proposal_hash ON tickets
WHEN OLD.proposal_hash IS NULL AND NEW.proposal_hash IS NOT NULL
BEGIN
  INSERT INTO proposal_revisions (
    ticket_id, revision, proposal_hash, proposal_json, edit_reason, edited_by, created_at
  ) VALUES (
    NEW.hubspot_ticket_id, NEW.proposal_revision, NEW.proposal_hash,
    json_object(
      'category', NEW.category,
      'priority', NEW.priority,
      'evidence_status', NEW.evidence_status,
      'summary', NEW.proposal_summary,
      'draft_reply', NEW.draft_reply,
      'cited_policy_keys', json(NEW.policy_keys_json),
      'rationale', NEW.proposal_rationale,
      'proposalHash', NEW.proposal_hash,
      'revision', NEW.proposal_revision,
      'promptVersion', NEW.prompt_version,
      'policyEvidence', json(NEW.policy_evidence_json)
    ), NULL, NULL, NEW.updated_at
  ) ON CONFLICT (ticket_id, revision) DO NOTHING;
END;
