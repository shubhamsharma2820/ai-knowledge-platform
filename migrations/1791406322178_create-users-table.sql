-- Up Migration
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::BIGINT),
    is_active SMALLINT NOT NULL DEFAULT 1,
    is_deleted SMALLINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_users_organisation_id ON users(organisation_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Down Migration
DROP TABLE IF EXISTS users;