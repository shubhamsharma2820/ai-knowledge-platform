-- Up Migration
CREATE TABLE IF NOT EXISTS knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_organisation_id
ON knowledge_documents (organisation_id);

ALTER TABLE knowledge_documents
ENABLE ROW LEVEL SECURITY;

ALTER TABLE knowledge_documents
FORCE ROW LEVEL SECURITY;

CREATE POLICY knowledge_documents_tenant_policy
ON knowledge_documents
FOR ALL
USING (
  organisation_id =
  NULLIF(current_setting('app.organisation_id', true), '')::UUID
)
WITH CHECK (
  organisation_id =
  NULLIF(current_setting('app.organisation_id', true), '')::UUID
);

-- Down Migration
DROP POLICY IF EXISTS knowledge_documents_tenant_policy ON knowledge_documents;
DROP TABLE IF EXISTS knowledge_documents;
