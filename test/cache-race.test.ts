process.env.NODE_ENV = 'test';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/database.js';
import { redis } from '../src/db/redis.js';
import {
  getOrganisationById,
  updateOrganisation,
} from '../src/modules/organisation/organisations.service.js';

describe('Cache Invalidation & Versioning vs In-Flight Read Race Condition', () => {
  const app = buildApp();
  let orgId: string;
  let cacheKey: string;
  let versionKey: string;
  const originalEval = redis.eval.bind(redis);

  before(async () => {
    await app.ready();
  });

  beforeEach(async () => {
    (redis as any).eval = originalEval;

    // Seed test organisation in PostgreSQL with initial name 'Acme' and default cache_version = 1
    const slug = `acme-race-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const result = await pool.query<{ id: string; cache_version: string | number }>(
      `INSERT INTO organisation (name, slug)
       VALUES ('Acme', $1)
       RETURNING id, cache_version`,
      [slug],
    );
    orgId = result.rows[0]!.id;
    cacheKey = `organisation:${orgId}`;
    versionKey = `organisation:${orgId}:version`;

    // Ensure cache starts empty
    await redis.del(cacheKey);
    await redis.del(versionKey);
  });

  after(async () => {
    (redis as any).eval = originalEval;

    if (orgId) {
      await pool.query(`DELETE FROM organisation WHERE id = $1`, [orgId]);
      await redis.del(cacheKey);
      await redis.del(versionKey);
    }

    await app.close();
  });

  test('PATCH /organisations/:id updates name and increments cache_version', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/organisations/${orgId}`,
      payload: { name: 'Acme Corp Updated' },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.name, 'Acme Corp Updated');
    assert.equal(String(body.cache_version), '2');

    // Calling update a second time increments cache_version to 3
    const secondResponse = await app.inject({
      method: 'PATCH',
      url: `/organisations/${orgId}`,
      payload: { name: 'Acme Corp Final' },
    });

    assert.equal(secondResponse.statusCode, 200);
    const secondBody = JSON.parse(secondResponse.body);
    assert.equal(secondBody.name, 'Acme Corp Final');
    assert.equal(String(secondBody.cache_version), '3');
  });

  test('prevents race condition: stale in-flight read is rejected and does not poison Redis after update', async () => {
    // Controllable promises for deterministic coordination without artificial timers
    let notifyPaused!: () => void;
    const pausedReached = new Promise<void>((resolve) => {
      notifyPaused = resolve;
    });

    let resumeExecution!: () => void;
    const allowResume = new Promise<void>((resolve) => {
      resumeExecution = resolve;
    });

    // Intercept redis.eval to pause execution after reading from DB and right before atomic write to Redis
    (redis as any).eval = (async (...args: any[]) => {
      notifyPaused();
      await allowResume;
      return (originalEval as any)(...args);
    }) as any;

    // Step 1: Begin a cache load (PostgreSQL lookup reads old value 'Acme' with cache_version = 1)
    const inFlightLoadPromise = getOrganisationById(orgId);

    // Step 2: Wait until the cache load reaches the pause point right before redis.eval
    await pausedReached;

    // Step 3: Update organisation to 'Acme Technologies' via updateOrganisation
    // This increments cache_version to 2 in DB, updates versionKey in Redis, and invalidates cacheKey
    const updatedOrg = await updateOrganisation(orgId, { name: 'Acme Technologies' });
    assert.equal(updatedOrg?.name, 'Acme Technologies');
    assert.equal(String(updatedOrg?.cache_version), '2');

    // Step 4: Allow the paused in-flight cache load to continue
    resumeExecution();
    const loadedResult = await inFlightLoadPromise;
    assert.equal(loadedResult?.name, 'Acme');

    // Step 5: Read the Redis cache key
    // With version-guarded atomic write, stale 'Acme' (version 1) was rejected because versionKey is 2!
    const cachedRaw = await redis.get(cacheKey);

    console.log('\n------------------------------------------------------');
    console.log('RACE CONDITION RESOLVED:');
    console.log('  Database current value:  Acme Technologies (version 2)');
    console.log(`  Redis cached value:      ${cachedRaw ? JSON.parse(cachedRaw).name : 'null (stale write was rejected!)'}`);
    console.log('------------------------------------------------------\n');

    assert.equal(
      cachedRaw,
      null,
      'Stale in-flight read must be rejected and must NOT poison Redis cache!',
    );

    // Step 6: Subsequent read fetches fresh 'Acme Technologies' with cache_version = 2
    (redis as any).eval = originalEval;
    const freshOrg = await getOrganisationById(orgId);
    assert.equal(freshOrg?.name, 'Acme Technologies');
    assert.equal(String(freshOrg?.cache_version), '2');

    // Redis cache now safely contains the updated data
    const freshCachedRaw = await redis.get(cacheKey);
    assert.ok(freshCachedRaw !== null);
    const freshCached = JSON.parse(freshCachedRaw);
    assert.equal(freshCached.name, 'Acme Technologies');
    assert.equal(String(freshCached.cache_version), '2');
  });

  test('post-commit invalidation: cache key is deleted after transaction commits successfully', async () => {
    // 1. Warm cache with initial data
    await getOrganisationById(orgId);
    const cachedBefore = await redis.get(cacheKey);
    assert.ok(cachedBefore !== null);

    // 2. Perform update
    const updated = await updateOrganisation(orgId, { name: 'Acme Post-Commit' });
    assert.equal(updated?.name, 'Acme Post-Commit');

    // 3. Confirm cache was invalidated post-commit
    const cachedAfter = await redis.get(cacheKey);
    assert.equal(cachedAfter, null, 'Cache key must be deleted after commit');

    // 4. Next read fetches updated data and repopulates cache
    const fresh = await getOrganisationById(orgId);
    assert.equal(fresh?.name, 'Acme Post-Commit');
  });
});


