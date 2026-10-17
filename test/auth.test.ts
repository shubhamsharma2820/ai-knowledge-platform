process.env.NODE_ENV = 'test';
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/database.js';
import { verifyPassword } from '../src/security/password.js';

describe('POST /auth/register - Registration flow tests', () => {
  const app = buildApp();
  const originalConnect = pool.connect;

  after(async () => {
    pool.connect = originalConnect;
    await app.close();
  });

  // Track transaction queries for verification
  let clientQueries: Array<{ text: string; params?: any[] | undefined }> = [];
  let rolledBack = false;
  let committed = false;
  let released = false;
  let simulateUserInsertFailure = false;
  let simulateDuplicateSlug = false;

  beforeEach(() => {
    clientQueries = [];
    rolledBack = false;
    committed = false;
    released = false;
    simulateUserInsertFailure = false;
    simulateDuplicateSlug = false;

    pool.connect = (async () => {
      const mockClient = {
        query: async (text: string, params?: any[]) => {
          clientQueries.push({ text, params });

          if (text === 'BEGIN') {
            return { rows: [] };
          }

          if (text === 'COMMIT') {
            committed = true;
            return { rows: [] };
          }

          if (text === 'ROLLBACK') {
            rolledBack = true;
            return { rows: [] };
          }

          if (typeof text === 'string' && text.includes('INSERT INTO organisation')) {
            if (simulateDuplicateSlug) {
              const err: any = new Error('duplicate key value violates unique constraint');
              err.code = '23505';
              err.constraint = 'organisation_slug_key';
              throw err;
            }
            return {
              rows: [
                {
                  id: 'org-uuid-1234',
                  name: params?.[0],
                  slug: params?.[1],
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
              ],
            };
          }

          if (typeof text === 'string' && text.includes('INSERT INTO users')) {
            if (simulateUserInsertFailure) {
              throw new Error('Database error during user insertion');
            }
            return {
              rows: [
                {
                  id: 'user-uuid-5678',
                  organisation_id: params?.[0],
                  name: params?.[1],
                  email: params?.[2],
                },
              ],
            };
          }

          return { rows: [] };
        },
        release: () => {
          released = true;
        },
      };

      return mockClient as any;
    }) as any;
  });

  const validPayload = {
    organisationName: 'Acme Corp',
    slug: 'acme',
    name: 'Alice Doe',
    email: 'alice@example.com',
    password: 'supersecretpassword123',
  };

  test('Case 1: Valid registration -> 201 Created with password hash in DB and never returned', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: validPayload,
    });

    assert.equal(response.statusCode, 201);
    const body = JSON.parse(response.body);

    // Verify response structure
    assert.ok(body.organisation);
    assert.equal(body.organisation.name, 'Acme Corp');
    assert.equal(body.organisation.slug, 'acme');

    assert.ok(body.user);
    assert.equal(body.user.name, 'Alice Doe');
    assert.equal(body.user.email, 'alice@example.com');

    // CRITICAL: Verify response NEVER includes password or password_hash
    assert.equal(body.password, undefined);
    assert.equal(body.password_hash, undefined);
    assert.equal(body.user.password, undefined);
    assert.equal(body.user.password_hash, undefined);

    // Verify transaction committed
    assert.equal(committed, true);
    assert.equal(rolledBack, false);
    assert.equal(released, true);

    // CRITICAL: Verify database received an Argon2 password_hash, NOT plain text password
    const userInsertQuery = clientQueries.find((q) =>
      q.text.includes('INSERT INTO users')
    );
    assert.ok(userInsertQuery, 'INSERT INTO users was called');
    const dbPasswordHash = userInsertQuery.params?.[3];

    assert.notEqual(dbPasswordHash, validPayload.password);
    assert.ok(
      typeof dbPasswordHash === 'string' && dbPasswordHash.startsWith('$argon2'),
      'Password in DB is an Argon2 hash'
    );

    // Verify the hashed password validates against the original password
    const isValid = await verifyPassword(dbPasswordHash, validPayload.password);
    assert.equal(isValid, true, 'Stored hash must verify against original password');
  });

  test('Case 2: Missing password -> 400 Bad Request', async () => {
    const { password, ...payloadWithoutPassword } = validPayload;

    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: payloadWithoutPassword,
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
    });
  });

  test('Case 3: Invalid email -> 400 Bad Request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { ...validPayload, email: 'not-an-email' },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
    });
  });

  test('Case 4: Password shorter than 12 characters -> 400 Bad Request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { ...validPayload, password: 'short' },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
    });
  });

  test('Case 5: Existing organization slug -> 409 Conflict', async () => {
    simulateDuplicateSlug = true;

    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: validPayload,
    });

    assert.equal(response.statusCode, 409);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'ORGANISATION_SLUG_CONFLICT',
      message: 'Organisation with this slug already exists',
    });

    // Verify rollback was executed and connection released
    assert.equal(rolledBack, true);
    assert.equal(committed, false);
    assert.equal(released, true);
  });

  test('Case 6: User insertion fails -> Transaction rolls back (no orphaned organisation)', async () => {
    simulateUserInsertFailure = true;

    const response = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: validPayload,
    });

    // Must return 500
    assert.equal(response.statusCode, 500);

    // Verify ROLLBACK was executed
    assert.equal(rolledBack, true, 'ROLLBACK must be executed when user insertion fails');
    assert.equal(committed, false, 'COMMIT must NOT be executed');
    assert.equal(released, true, 'Client connection must be released');

    // Confirm execution sequence: BEGIN -> INSERT INTO organisation -> INSERT INTO users (failed) -> ROLLBACK
    const queryTypes = clientQueries.map((q) => {
      if (q.text === 'BEGIN') return 'BEGIN';
      if (q.text === 'COMMIT') return 'COMMIT';
      if (q.text === 'ROLLBACK') return 'ROLLBACK';
      if (q.text.includes('INSERT INTO organisation')) return 'INSERT_ORG';
      if (q.text.includes('INSERT INTO users')) return 'INSERT_USER';
      return q.text;
    });

    assert.deepEqual(queryTypes, [
      'BEGIN',
      'INSERT_ORG',
      'INSERT_USER',
      'ROLLBACK',
    ]);
  });
});
