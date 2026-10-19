process.env.NODE_ENV = 'test';
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/database.js';
import { withTenantTransaction } from '../src/db/tenant-transaction.js';

describe('GET /documents - Cross-organization isolation & RLS tests', () => {
  const app = buildApp();

  let orgAId: string;
  let orgBId: string;
  let userAId: string;
  let userBId: string;
  let inactiveUserId: string;

  let tokenA: string;
  let tokenB: string;
  let inactiveUserToken: string;

  before(async () => {
    await app.ready();

    // 1. Critical verification: Check database role privileges
    const roleCheck = await pool.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT current_user, rolsuper, rolbypassrls
       FROM pg_roles
       WHERE rolname = current_user`
    );

    const currentUserInfo = roleCheck.rows[0];
    console.log('Database Connection Role Check:', currentUserInfo);

    // 2. Clean and Seed Test Organizations
    const orgAResult = await pool.query(
      `INSERT INTO organisation (name, slug)
       VALUES ('Organisation A', $1)
       RETURNING id`,
      [`org-a-${Date.now()}`]
    );
    orgAId = orgAResult.rows[0]!.id;

    const orgBResult = await pool.query(
      `INSERT INTO organisation (name, slug)
       VALUES ('Organisation B', $1)
       RETURNING id`,
      [`org-b-${Date.now()}`]
    );
    orgBId = orgBResult.rows[0]!.id;

    // 3. Seed Users for Org A and Org B
    const userAResult = await pool.query(
      `INSERT INTO users (organisation_id, name, email, password_hash, is_active, is_deleted)
       VALUES ($1, 'User A', $2, 'dummyhash', 1, 0)
       RETURNING id`,
      [orgAId, `usera-${Date.now()}@example.com`]
    );
    userAId = userAResult.rows[0]!.id;

    const userBResult = await pool.query(
      `INSERT INTO users (organisation_id, name, email, password_hash, is_active, is_deleted)
       VALUES ($1, 'User B', $2, 'dummyhash', 1, 0)
       RETURNING id`,
      [orgBId, `userb-${Date.now()}@example.com`]
    );
    userBId = userBResult.rows[0]!.id;

    // Inactive user in Org A (is_active = 0)
    const inactiveUserResult = await pool.query(
      `INSERT INTO users (organisation_id, name, email, password_hash, is_active, is_deleted)
       VALUES ($1, 'Inactive User', $2, 'dummyhash', 0, 0)
       RETURNING id`,
      [orgAId, `inactive-${Date.now()}@example.com`]
    );
    inactiveUserId = inactiveUserResult.rows[0]!.id;

    // 4. Seed documents for Org A and Org B through the tenant-aware helper
    await withTenantTransaction(orgAId, async (client) => {
      await client.query(
        `INSERT INTO knowledge_documents (organisation_id, title)
         VALUES ($1, 'Org A Confidential Document')`,
        [orgAId]
      );
    });

    await withTenantTransaction(orgBId, async (client) => {
      await client.query(
        `INSERT INTO knowledge_documents (organisation_id, title)
         VALUES ($1, 'Org B Secret Strategy')`,
        [orgBId]
      );
    });

    // 5. Generate tokens for each user
    tokenA = app.jwt.sign({ sub: userAId, organisationId: orgAId });
    tokenB = app.jwt.sign({ sub: userBId, organisationId: orgBId });
    inactiveUserToken = app.jwt.sign({ sub: inactiveUserId, organisationId: orgAId });
  });

  after(async () => {
    // Cleanup seeded data
    if (orgAId && orgBId) {
      await pool.query('DELETE FROM organisation WHERE id IN ($1, $2)', [orgAId, orgBId]);
    }
    await app.close();
  });

  test('Critical verification: confirm that tenant transactions execute under non-superuser role without BYPASSRLS', async () => {
    await withTenantTransaction(orgAId, async (client) => {
      const roleCheck = await client.query<{
        current_user: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        `SELECT current_user, rolsuper, rolbypassrls
         FROM pg_roles
         WHERE rolname = current_user`
      );
      const role = roleCheck.rows[0];
      assert.ok(role, 'Database role must exist');
      assert.equal(role.current_user, 'app_user', 'Transaction must execute as app_user role');
      assert.equal(role.rolsuper, false, 'Tenant transaction must NOT run as superuser');
      assert.equal(role.rolbypassrls, false, 'Tenant transaction must NOT have BYPASSRLS privilege');
    });
  });

  test('Request 1: Organization A token → GET /documents returns only As documents', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/documents',
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });

    assert.equal(response.statusCode, 200);
    const documents = JSON.parse(response.body);

    assert.ok(Array.isArray(documents), 'Response must be an array of documents');
    assert.ok(documents.length >= 1, 'Org A must have at least one document');

    // Every returned document must strictly belong to Organisation A
    for (const doc of documents) {
      assert.equal(doc.organisation_id, orgAId);
      assert.equal(doc.title, 'Org A Confidential Document');
      assert.notEqual(doc.organisation_id, orgBId);
    }
  });

  test('Request 2: Organization B token → GET /documents returns only Bs documents', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/documents',
      headers: {
        authorization: `Bearer ${tokenB}`,
      },
    });

    assert.equal(response.statusCode, 200);
    const documents = JSON.parse(response.body);

    assert.ok(Array.isArray(documents), 'Response must be an array of documents');
    assert.ok(documents.length >= 1, 'Org B must have at least one document');

    // Every returned document must strictly belong to Organisation B
    for (const doc of documents) {
      assert.equal(doc.organisation_id, orgBId);
      assert.equal(doc.title, 'Org B Secret Strategy');
      assert.notEqual(doc.organisation_id, orgAId);
    }
  });

  test('Request 3: No token → GET /documents returns 401 Unauthorized', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/documents',
    });

    assert.equal(response.statusCode, 401);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'UNAUTHORIZED',
      message: 'A valid access token is required',
    });
  });

  test('Request 4: Valid token for inactive user → GET /documents returns 401 Unauthorized', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/documents',
      headers: {
        authorization: `Bearer ${inactiveUserToken}`,
      },
    });

    assert.equal(response.statusCode, 401);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'UNAUTHORIZED',
      message: 'The account is unavailable',
    });
  });
});
