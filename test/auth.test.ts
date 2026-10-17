process.env.NODE_ENV = 'test';
import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/database.js';
import { hashPassword, verifyPassword } from '../src/security/password.js';

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

describe('POST /auth/login & GET /auth/me - Authentication & Session tests', () => {
  const app = buildApp();
  const originalQuery = pool.query;

  after(async () => {
    pool.query = originalQuery;
    await app.close();
  });

  let validPasswordHash = '';
  const testPassword = 'Correct-Password-123!';
  const testEmail = 'user@example.com';

  beforeEach(async () => {
    if (!validPasswordHash) {
      validPasswordHash = await hashPassword(testPassword);
    }
  });

  test('Login Case 1: Valid credentials -> 200 OK with JWT accessToken', async () => {
    pool.query = (async () => {
      return {
        rows: [
          {
            id: 'user-uuid-100',
            organisation_id: 'org-uuid-200',
            name: 'Bob Smith',
            email: testEmail,
            password_hash: validPasswordHash,
            is_active: 1,
            is_deleted: 0,
          },
        ],
      };
    }) as any;

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: testEmail,
        password: testPassword,
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);

    assert.ok(body.accessToken, 'Access token must be present');
    assert.equal(body.tokenType, 'Bearer');
    assert.equal(body.expiresIn, 900);
    assert.deepEqual(body.user, {
      id: 'user-uuid-100',
      name: 'Bob Smith',
      email: testEmail,
    });
  });

  test('Login Case 2: Wrong password -> 401 Unauthorized', async () => {
    pool.query = (async () => {
      return {
        rows: [
          {
            id: 'user-uuid-100',
            organisation_id: 'org-uuid-200',
            name: 'Bob Smith',
            email: testEmail,
            password_hash: validPasswordHash,
            is_active: 1,
            is_deleted: 0,
          },
        ],
      };
    }) as any;

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: testEmail,
        password: 'wrong-password-here',
      },
    });

    assert.equal(response.statusCode, 401);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password',
    });
  });

  test('Login Case 3: User not found -> 401 Unauthorized (timing-safe generic message)', async () => {
    pool.query = (async () => {
      return { rows: [] };
    }) as any;

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: 'nonexistent@example.com',
        password: testPassword,
      },
    });

    assert.equal(response.statusCode, 401);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password',
    });
  });

  test('Login Case 4: Inactive account (is_active = 0) -> 403 Forbidden', async () => {
    pool.query = (async () => {
      return {
        rows: [
          {
            id: 'user-uuid-100',
            organisation_id: 'org-uuid-200',
            name: 'Bob Smith',
            email: testEmail,
            password_hash: validPasswordHash,
            is_active: 0,
            is_deleted: 0,
          },
        ],
      };
    }) as any;

    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: testEmail,
        password: testPassword,
      },
    });

    assert.equal(response.statusCode, 403);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'ACCOUNT_UNAVAILABLE',
      message: 'Account is unavailable',
    });
  });

  test('Login Case 5: Missing password -> 400 Bad Request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: testEmail,
      },
    });

    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'VALIDATION_ERROR',
      message: 'Request validation failed',
    });
  });

  test('GET /auth/me Case 1: Valid JWT token -> 200 OK with user & organisation identity', async () => {
    pool.query = (async (text: string) => {
      if (typeof text === 'string' && text.includes('FROM users')) {
        return {
          rows: [
            {
              id: 'user-uuid-100',
              organisation_id: 'org-uuid-200',
              role: 'admin',
              is_active: 1,
              is_deleted: 0,
            },
          ],
        };
      }
      return { rows: [] };
    }) as any;

    // Generate valid token using app's JWT instance
    const token = app.jwt.sign({
      sub: 'user-uuid-100',
      organisationId: 'org-uuid-200',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      userId: 'user-uuid-100',
      organisationId: 'org-uuid-200',
    });
  });

  test('GET /auth/me Case 2: Missing authorization header -> 401 Unauthorized', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
    });

    assert.equal(response.statusCode, 401);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'UNAUTHORIZED',
      message: 'A valid access token is required',
    });
  });

  test('GET /auth/me Case 3: Invalid / forged token -> 401 Unauthorized', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        authorization: 'Bearer invalid.tampered.token',
      },
    });

    assert.equal(response.statusCode, 401);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'UNAUTHORIZED',
      message: 'A valid access token is required',
    });
  });

  test('GET /auth/me Case 4: Expired token -> 401 Unauthorized', async () => {
    const expiredToken = app.jwt.sign(
      {
        sub: 'user-uuid-100',
        organisationId: 'org-uuid-200',
      },
      { expiresIn: '10ms' }
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        authorization: `Bearer ${expiredToken}`,
      },
    });

    assert.equal(response.statusCode, 401);
    const body = JSON.parse(response.body);
    assert.deepEqual(body, {
      error: 'UNAUTHORIZED',
      message: 'A valid access token is required',
    });
  });
});

describe('Full Authentication Lifecycle E2E Flow (Steps 1 to 6)', () => {
  const app = buildApp();
  const originalConnect = pool.connect;
  const originalQuery = pool.query;

  // In-memory database simulation for full flow
  const inMemoryOrganisations: Array<{ id: string; name: string; slug: string }> = [];
  const inMemoryUsers: Array<{
    id: string;
    organisation_id: string;
    name: string;
    email: string;
    password_hash: string;
    is_active: number;
    is_deleted: number;
  }> = [];

  after(async () => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
    await app.close();
  });

  beforeEach(() => {
    inMemoryOrganisations.length = 0;
    inMemoryUsers.length = 0;

    // Client connection handler for transactions (register)
    pool.connect = (async () => {
      const mockClient = {
        query: async (text: string, params?: any[]) => {
          if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
            return { rows: [] };
          }

          if (typeof text === 'string' && text.includes('INSERT INTO organisation')) {
            const org = {
              id: 'e2e-org-id-1234',
              name: params?.[0],
              slug: params?.[1],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
            inMemoryOrganisations.push(org);
            return { rows: [org] };
          }

          if (typeof text === 'string' && text.includes('INSERT INTO users')) {
            const user = {
              id: 'e2e-user-id-5678',
              organisation_id: params?.[0],
              name: params?.[1],
              email: params?.[2],
              password_hash: params?.[3],
              role: 'owner',
              is_active: 1,
              is_deleted: 0,
            };
            inMemoryUsers.push(user);
            return {
              rows: [
                {
                  id: user.id,
                  organisation_id: user.organisation_id,
                  name: user.name,
                  email: user.email,
                },
              ],
            };
          }

          return { rows: [] };
        },
        release: () => {},
      };
      return mockClient as any;
    }) as any;

    // Single query handler (login & requireActiveUser)
    pool.query = (async (text: string, params?: any[]) => {
      if (typeof text === 'string' && text.includes('FROM users')) {
        if (text.includes('WHERE id = $1')) {
          const id = String(params?.[0] || '');
          const found = inMemoryUsers.find((u) => u.id === id);
          return { rows: found ? [found] : [] };
        }
        const email = String(params?.[0] || '').toLowerCase().trim();
        const found = inMemoryUsers.find(
          (u) => u.email.toLowerCase().trim() === email
        );
        return { rows: found ? [found] : [] };
      }
      return { rows: [] };
    }) as any;
  });

  test('Execute complete 6-step authentication lifecycle', async () => {
    const testAccount = {
      organisationName: 'Acme E2E Corp',
      slug: 'acme-e2e',
      name: 'E2E Tester',
      email: 'e2e-tester@example.com',
      password: 'Strong-Password-1234!',
    };

    // 1. Register a test account — expect 201 Created
    const registerResponse = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: testAccount,
    });
    assert.equal(registerResponse.statusCode, 201, 'Step 1: Expected 201 Created');
    assert.equal(
      registerResponse.body.includes('password_hash'),
      false,
      'Step 1: Response must not contain password_hash'
    );
    const registerData = JSON.parse(registerResponse.body);
    assert.equal(registerData.organisation.name, testAccount.organisationName);
    assert.equal(registerData.user.email, testAccount.email);

    // 2. Log in with the correct password — expect 200 and an access token
    const loginSuccessResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: testAccount.email,
        password: testAccount.password,
      },
    });
    assert.equal(loginSuccessResponse.statusCode, 200, 'Step 2: Expected 200 OK');
    assert.equal(
      loginSuccessResponse.body.includes('password_hash'),
      false,
      'Step 2: Response must not contain password_hash'
    );
    const loginData = JSON.parse(loginSuccessResponse.body);
    const accessToken = loginData.accessToken;
    assert.ok(accessToken, 'Step 2: Access token must be present');
    assert.equal(loginData.tokenType, 'Bearer');
    assert.equal(loginData.expiresIn, 900);

    // 3. Log in with an incorrect password — expect 401 Unauthorized
    const loginFailResponse = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: testAccount.email,
        password: 'Incorrect-Password-999!',
      },
    });
    assert.equal(loginFailResponse.statusCode, 401, 'Step 3: Expected 401 Unauthorized');
    assert.equal(
      loginFailResponse.body.includes('password_hash'),
      false,
      'Step 3: Response must not contain password_hash'
    );
    const failBody = JSON.parse(loginFailResponse.body);
    assert.equal(failBody.error, 'INVALID_CREDENTIALS');

    // 4. Call /me without a token — expect 401 Unauthorized
    const meWithoutTokenResponse = await app.inject({
      method: 'GET',
      url: '/auth/me',
    });
    assert.equal(meWithoutTokenResponse.statusCode, 401, 'Step 4: Expected 401 Unauthorized');
    assert.equal(
      meWithoutTokenResponse.body.includes('password_hash'),
      false,
      'Step 4: Response must not contain password_hash'
    );
    const noTokenBody = JSON.parse(meWithoutTokenResponse.body);
    assert.equal(noTokenBody.error, 'UNAUTHORIZED');

    // 5. Call /me with Authorization: Bearer YOUR_TOKEN — expect 200 OK
    const meWithTokenResponse = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });
    assert.equal(meWithTokenResponse.statusCode, 200, 'Step 5: Expected 200 OK');
    assert.equal(
      meWithTokenResponse.body.includes('password_hash'),
      false,
      'Step 5: Response must not contain password_hash'
    );
    const meData = JSON.parse(meWithTokenResponse.body);
    assert.equal(meData.userId, registerData.user.id);
    assert.equal(meData.organisationId, registerData.organisation.id);

    // 6. Wait for the token to expire and call /me again — expect 401 Unauthorized
    const expiredToken = app.jwt.sign(
      {
        sub: registerData.user.id,
        organisationId: registerData.organisation.id,
      },
      { expiresIn: '10ms' }
    );
    // Wait for the token to expire
    await new Promise((resolve) => setTimeout(resolve, 30));

    const meExpiredResponse = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        authorization: `Bearer ${expiredToken}`,
      },
    });
    assert.equal(meExpiredResponse.statusCode, 401, 'Step 6: Expected 401 Unauthorized');
    assert.equal(
      meExpiredResponse.body.includes('password_hash'),
      false,
      'Step 6: Response must not contain password_hash'
    );
    const expiredBody = JSON.parse(meExpiredResponse.body);
    assert.equal(expiredBody.error, 'UNAUTHORIZED');
  });
});

