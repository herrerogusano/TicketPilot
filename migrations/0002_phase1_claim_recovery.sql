ALTER TABLE tickets ADD COLUMN admission_utc_day TEXT;
ALTER TABLE tickets ADD COLUMN workflow_create_status TEXT NOT NULL DEFAULT 'PENDING'
  CHECK (workflow_create_status IN ('PENDING', 'CREATING', 'STARTED', 'MANUAL_REVIEW'));
ALTER TABLE tickets ADD COLUMN workflow_create_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (workflow_create_attempts BETWEEN 0 AND 3);

CREATE INDEX IF NOT EXISTS tickets_workflow_recovery_idx
  ON tickets (workflow_create_status, created_at);
CREATE INDEX IF NOT EXISTS tickets_admission_day_idx ON tickets (admission_utc_day);

CREATE TRIGGER IF NOT EXISTS tickets_daily_admission_limit
BEFORE INSERT ON tickets
WHEN NEW.admission_utc_day IS NOT NULL
BEGIN
  SELECT RAISE(IGNORE)
    WHERE EXISTS (
      SELECT 1 FROM tickets WHERE hubspot_ticket_id = NEW.hubspot_ticket_id
    );
  SELECT RAISE(ABORT, 'daily admission limit reached')
    WHERE COALESCE((
      SELECT accepted_ticket_count FROM daily_usage WHERE utc_day = NEW.admission_utc_day
    ), 0) >= 20;
END;

CREATE TRIGGER IF NOT EXISTS tickets_count_daily_admission
AFTER INSERT ON tickets
WHEN NEW.admission_utc_day IS NOT NULL
BEGIN
  INSERT INTO daily_usage (utc_day, accepted_ticket_count)
  VALUES (NEW.admission_utc_day, 1)
  ON CONFLICT (utc_day) DO UPDATE SET
    accepted_ticket_count = accepted_ticket_count + 1;
END;
