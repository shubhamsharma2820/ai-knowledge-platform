import { pool } from '../src/db/database.js';
import { buildApp } from '../src/app.js';
import { withTenantTransaction } from '../src/db/tenant-transaction.js';

async function main() {
  const app = buildApp();
  await app.ready();

  // 1. Get or create Anthropic organisation
  const orgRes = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM organisation WHERE slug = 'anthropic' LIMIT 1`,
  );

  let orgId = orgRes.rows[0]?.id;
  if (!orgId) {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO organisation (name, slug)
       VALUES ('Anthropic', 'anthropic')
       RETURNING id`,
    );
    orgId = inserted.rows[0]!.id;
  }

  // 2. Get or create active user
  const userRes = await pool.query<{ id: string; email: string }>(
    `SELECT id, email FROM users
     WHERE organisation_id = $1 AND is_active = 1
     LIMIT 1`,
    [orgId],
  );

  let userId = userRes.rows[0]?.id;
  if (!userId) {
    const insertedUser = await pool.query<{ id: string }>(
      `INSERT INTO users (organisation_id, name, email, password_hash, is_active, is_deleted)
       VALUES ($1, 'Dev Tester', 'dev@anthropic.com', 'dummyhash', 1, 0)
       RETURNING id`,
      [orgId],
    );
    userId = insertedUser.rows[0]!.id;
  }

  // 3. Ensure test documents exist
  await withTenantTransaction(orgId, async (client) => {
    const countRes = await client.query<{ count: string }>(
      `SELECT count(*) FROM knowledge_documents`,
    );
    if (parseInt(countRes.rows[0]!.count, 10) === 0) {
      await client.query(
        `INSERT INTO knowledge_documents (organisation_id, title)
         VALUES 
          ($1, 'Claude 3.5 Sonnet Architecture Guide'),
          ($1, 'Constitutional AI Safety Guidelines'),
          ($1, 'Prompt Engineering Best Practices'),
          ($1, 'Vector Search & Embeddings Overview')`,
        [orgId],
      );
    }
  });

  // 4. Generate 7-day token
  const token = app.jwt.sign(
    { sub: userId, organisationId: orgId },
    { expiresIn: '7d' },
  );

  console.log(`\n======================================================`);
  console.log(`Organization: Anthropic (${orgId})`);
  console.log(`User ID:      ${userId}`);
  console.log(`======================================================`);
  console.log(`\nJWT Access Token (Valid for 7 days):\n`);
  console.log(token);
  console.log(`\n======================================================\n`);

  await app.close();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
