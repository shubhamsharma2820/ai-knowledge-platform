-- Up Migration
ALTER TABLE organisation
ADD COLUMN IF NOT EXISTS cache_version BIGINT NOT NULL DEFAULT 1;

-- Down Migration
ALTER TABLE organisation
DROP COLUMN IF EXISTS cache_version;