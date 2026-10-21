-- Up Migration
CREATE TABLE IF NOT EXISTS outbox_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ,
  claimed_by TEXT
);

ALTER TABLE outbox_events
ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS claimed_by TEXT;

CREATE INDEX IF NOT EXISTS idx_outbox_events_pending
ON outbox_events (id)
WHERE processed_at IS NULL;

-- Down Migration
DROP INDEX IF EXISTS idx_outbox_events_pending;
DROP TABLE IF EXISTS outbox_events;