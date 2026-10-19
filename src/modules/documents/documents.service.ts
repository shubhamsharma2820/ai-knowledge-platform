import { withTenantTransaction } from '../../db/tenant-transaction.js';

export async function listDocuments(organisationId: string) {
  return withTenantTransaction(organisationId, async (client) => {
    const result = await client.query(
      `SELECT id, organisation_id, title, created_at
       FROM knowledge_documents
       ORDER BY created_at DESC`,
    );

    return result.rows;
  });
}