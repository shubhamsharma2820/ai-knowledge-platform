-- Up Migration
ALTER TABLE outbox_events
ADD COLUMN IF NOT EXISTS last_error TEXT,
ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_outbox_events_retry
ON outbox_events (next_attempt_at, id)
WHERE processed_at IS NULL
  AND failed_at IS NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_outbox_events_retry;

ALTER TABLE outbox_events
DROP COLUMN IF EXISTS last_error,
DROP COLUMN IF EXISTS failed_at,
DROP COLUMN IF EXISTS next_attempt_at;
