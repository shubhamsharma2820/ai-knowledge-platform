process.env.NODE_ENV = 'test';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/database.js';
import { redis } from '../src/db/redis.js';

describe('User-Level Authenticated Rate Limiting (/rate-limit-test)', () => {
  const app = buildApp();
  let orgId: string;
  let user1Id: string;
  let user2Id: string;
  let user1Token: string;
  let user2Token: string;

  before(async () => {
    await app.ready();

    // 1. Seed an organisation
    const orgResult = await pool.query<{ id: string }>(
      `INSERT INTO organisation (name, slug)
       VALUES ('Rate Limit Org', $1)
       RETURNING id;`,
      [`ratelimit-org-${Date.now()}`],
    );
    orgId = orgResult.rows[0]!.id;

    // 2. Seed User 1 & User 2
    const user1Result = await pool.query<{ id: string }>(
      `INSERT INTO users (organisation_id, name, email, password_hash, is_active, is_deleted)
       VALUES ($1, 'User One', $2, 'dummyhash', 1, 0)
       RETURNING id;`,
      [orgId, `user1-${Date.now()}@example.com`],
    );
    user1Id = user1Result.rows[0]!.id;

    const user2Result = await pool.query<{ id: string }>(
      `INSERT INTO users (organisation_id, name, email, password_hash, is_active, is_deleted)
       VALUES ($1, 'User Two', $2, 'dummyhash', 1, 0)
       RETURNING id;`,
      [orgId, `user2-${Date.now()}@example.com`],
    );
    user2Id = user2Result.rows[0]!.id;

    // 3. Generate access tokens
    user1Token = app.jwt.sign({ sub: user1Id, organisationId: orgId });
    user2Token = app.jwt.sign({ sub: user2Id, organisationId: orgId });

    // Ensure Redis keys start clean
    await redis.del(`rate-limit:user:${user1Id}`);
    await redis.del(`rate-limit:user:${user2Id}`);
  });

  after(async () => {
    if (orgId) {
      await pool.query('DELETE FROM users WHERE organisation_id = $1', [orgId]);
      await pool.query('DELETE FROM organisation WHERE id = $1', [orgId]);
    }
    if (user1Id) await redis.del(`rate-limit:user:${user1Id}`);
    if (user2Id) await redis.del(`rate-limit:user:${user2Id}`);
    await app.close();
  });

  test('unauthenticated requests fail closed with 401 Unauthorized', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/rate-limit-test',
    });
    assert.equal(res.statusCode, 401);
  });

  test('User 1 reaches 5-request limit and is blocked on 6th request with 429', async () => {
    // Requests 1–5: Allowed (200 OK)
    for (let i = 1; i <= 5; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/rate-limit-test',
        headers: {
          authorization: `Bearer ${user1Token}`,
        },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['x-ratelimit-limit'], '5');
      assert.equal(response.headers['x-ratelimit-remaining'], String(5 - i));

      const body = JSON.parse(response.body);
      assert.equal(body.message, 'Request allowed');
      assert.equal(body.count, i);
      assert.equal(body.remaining, 5 - i);
    }

    // Request 6: Blocked (429 Too Many Requests)
    const blockedResponse = await app.inject({
      method: 'GET',
      url: '/rate-limit-test',
      headers: {
        authorization: `Bearer ${user1Token}`,
      },
    });

    assert.equal(blockedResponse.statusCode, 429);
    assert.equal(blockedResponse.headers['x-ratelimit-limit'], '5');
    assert.equal(blockedResponse.headers['x-ratelimit-remaining'], '0');
    assert.equal(blockedResponse.headers['retry-after'], '60');

    const blockedBody = JSON.parse(blockedResponse.body);
    assert.equal(blockedBody.error, 'Too Many Requests');
    assert.equal(blockedBody.message, 'Rate limit exceeded. Try again later.');
  });

  test('User 2 has an independent counter and is allowed even when sharing the same office IP', async () => {
    // User 1 is still blocked on request 7
    const user1Blocked = await app.inject({
      method: 'GET',
      url: '/rate-limit-test',
      headers: {
        authorization: `Bearer ${user1Token}`,
      },
      remoteAddress: '198.51.100.1', // Same shared office IP
    });
    assert.equal(user1Blocked.statusCode, 429);

    // User 2 makes a request from the exact same shared office IP
    const user2Allowed = await app.inject({
      method: 'GET',
      url: '/rate-limit-test',
      headers: {
        authorization: `Bearer ${user2Token}`,
      },
      remoteAddress: '198.51.100.1', // Same shared office IP
    });

    assert.equal(user2Allowed.statusCode, 200);
    assert.equal(user2Allowed.headers['x-ratelimit-limit'], '5');
    assert.equal(user2Allowed.headers['x-ratelimit-remaining'], '4');

    const body = JSON.parse(user2Allowed.body);
    assert.equal(body.message, 'Request allowed');
    assert.equal(body.count, 1);
    assert.equal(body.remaining, 4);
  });
});
