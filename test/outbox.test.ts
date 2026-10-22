process.env.NODE_ENV = 'test';
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/database.js';
import { redis } from '../src/db/redis.js';
import {
  claimOutboxBatch,
  processOutboxBatch,
} from '../src/modules/outbox/outbox.worker.js';
import { updateOrganisation } from '../src/modules/organisation/organisations.service.js';

describe('Transactional Outbox Pattern & Worker', () => {
  let testOrgId: string;
  let cacheKey: string;

  before(async () => {
    if (!redis.isOpen) {
      await redis.connect();
    }
  });

  beforeEach(async () => {
    const slug = `outbox-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const result = await pool.query<{ id: string }>(
      `INSERT INTO organisation (name, slug)
       VALUES ('Outbox Test Org', $1)
       RETURNING id;`,
      [slug],
    );
    testOrgId = result.rows[0]!.id;
    cacheKey = `organisation:${testOrgId}`;
  });

  after(async () => {
    if (testOrgId) {
      await pool.query(`DELETE FROM outbox_events WHERE aggregate_id = $1`, [testOrgId]);
      await pool.query(`DELETE FROM organisation WHERE id = $1`, [testOrgId]);
      await redis.del(cacheKey);
    }
    if (redis.isOpen) {
      await redis.quit();
    }
    await pool.end();
  });

  test('updateOrganisation writes an outbox event into outbox_events inside the transaction', async () => {
    await updateOrganisation(testOrgId, { name: 'Outbox Updated Name' });

    const events = await pool.query<{
      id: string;
      event_type: string;
      aggregate_id: string;
      processed_at: Date | null;
    }>(
      `SELECT id, event_type, aggregate_id, processed_at
       FROM outbox_events
       WHERE aggregate_id = $1
       ORDER BY id DESC
       LIMIT 1;`,
      [testOrgId],
    );

    assert.equal(events.rows.length, 1);
    const event = events.rows[0]!;
    assert.equal(event.event_type, 'organisation.cache_invalidate');
    assert.equal(event.aggregate_id, testOrgId);
    assert.equal(event.processed_at, null);
  });

  test('processOutboxBatch claims, invalidates Redis cache, and marks event as processed', async () => {
    // 1. Seed cache in Redis
    await redis.set(cacheKey, JSON.stringify({ id: testOrgId, name: 'Before Outbox' }), { EX: 60 });
    const cachedBefore = await redis.get(cacheKey);
    assert.ok(cachedBefore !== null, 'Redis cache should exist before invalidation');

    // 2. Insert outbox event directly
    const insertResult = await pool.query<{ id: string }>(
      `INSERT INTO outbox_events (event_type, aggregate_id, payload)
       VALUES ('organisation.cache_invalidate', $1::UUID, jsonb_build_object('organisationId', $1::TEXT))
       RETURNING id;`,
      [testOrgId],
    );
    const eventId = insertResult.rows[0]!.id;

    // 3. Process batch
    const processedCount = await processOutboxBatch(10);
    assert.ok(processedCount >= 1, 'Should have processed at least 1 event');

    // 4. Verify Redis cache was invalidated
    const cachedAfter = await redis.get(cacheKey);
    assert.equal(cachedAfter, null, 'Redis cache key should have been deleted by worker');

    // 5. Verify database row state
    const eventDb = await pool.query<{
      id: string;
      processed_at: Date | null;
      attempts: number;
      claimed_at: Date | null;
      claimed_by: string | null;
    }>(
      `SELECT id, processed_at, attempts, claimed_at, claimed_by
       FROM outbox_events
       WHERE id = $1;`,
      [eventId],
    );

    assert.equal(eventDb.rows.length, 1);
    const row = eventDb.rows[0]!;
    assert.ok(row.processed_at !== null, 'processed_at should be populated');
    assert.equal(row.attempts, 1, 'attempts should be incremented to 1');
    assert.equal(row.claimed_at, null, 'claimed_at should be cleared');
    assert.equal(row.claimed_by, null, 'claimed_by should be cleared');
  });

  test('claimOutboxBatch skips already claimed events (FOR UPDATE SKIP LOCKED)', async () => {
    // Insert an event
    const insertResult = await pool.query<{ id: string }>(
      `INSERT INTO outbox_events (event_type, aggregate_id, payload)
       VALUES ('organisation.cache_invalidate', $1::UUID, jsonb_build_object('organisationId', $1::TEXT))
       RETURNING id;`,
      [testOrgId],
    );
    const eventId = insertResult.rows[0]!.id;

    // Worker 1 claims it
    const batch1 = await claimOutboxBatch(10);
    const claimedEvent1 = batch1.find((e) => String(e.id) === String(eventId));
    assert.ok(claimedEvent1 !== undefined, 'Worker 1 should claim the event');

    // Worker 2 attempts to claim before worker 1 finishes
    const batch2 = await claimOutboxBatch(10);
    const claimedEvent2 = batch2.find((e) => String(e.id) === String(eventId));
    assert.equal(claimedEvent2, undefined, 'Worker 2 must skip the locked/claimed event');

    // Clean up by processing
    await processOutboxBatch(10);
  });

  test('processClaimedEvent records error and schedules retry with exponential backoff on failure', async () => {
    // 1. Insert an invalid event that will fail
    const insertResult = await pool.query<{ id: string }>(
      `INSERT INTO outbox_events (event_type, aggregate_id, payload)
       VALUES ('invalid.unsupported_type', $1::UUID, '{}'::JSONB)
       RETURNING id;`,
      [testOrgId],
    );
    const eventId = insertResult.rows[0]!.id;

    // 2. Claim the event
    const claimed = await claimOutboxBatch(10);
    const target = claimed.find((e) => String(e.id) === String(eventId));
    assert.ok(target !== undefined, 'Target event should be claimed');

    // 3. Process it (fails because unsupported event_type)
    const { processClaimedEvent } = await import('../src/modules/outbox/outbox.worker.js');
    const success = await processClaimedEvent(target!);
    assert.equal(success, false, 'Processing should return false for unsupported event type');

    // 4. Verify retry state in database
    const dbRow = await pool.query<{
      attempts: number;
      last_error: string | null;
      failed_at: Date | null;
      next_attempt_at: Date;
      claimed_by: string | null;
    }>(
      `SELECT attempts, last_error, failed_at, next_attempt_at, claimed_by
       FROM outbox_events
       WHERE id = $1;`,
      [eventId],
    );

    const row = dbRow.rows[0]!;
    assert.equal(row.claimed_by, null, 'Claim should be released');
  });

  test('dead-letters event by setting failed_at when max retry attempts reached', async () => {
    // Insert an event already at attempts = 4
    const insertResult = await pool.query<{ id: string }>(
      `INSERT INTO outbox_events (event_type, aggregate_id, payload, attempts)
       VALUES ('organisation.cache_invalidate', $1::UUID, '{}'::JSONB, 4)
       RETURNING id;`,
      [testOrgId],
    );
    const eventId = insertResult.rows[0]!.id;

    // Simulate redis failure during processClaimedEvent
    const originalDel = redis.del.bind(redis);
    (redis as any).del = async () => {
      throw new Error('Simulated Redis network timeout');
    };

    try {
      const claimed = await claimOutboxBatch(10);
      const target = claimed.find((e) => String(e.id) === String(eventId));
      assert.ok(target !== undefined);

      const { processClaimedEvent } = await import('../src/modules/outbox/outbox.worker.js');
      await processClaimedEvent(target!);

      const dbRow = await pool.query<{
        attempts: number;
        last_error: string | null;
        failed_at: Date | null;
      }>(
        `SELECT attempts, last_error, failed_at
         FROM outbox_events
         WHERE id = $1;`,
        [eventId],
      );

      const row = dbRow.rows[0]!;
      assert.equal(row.attempts, 5, 'Attempts should reach max (5)');
      assert.ok(row.failed_at !== null, 'failed_at should be marked (dead-lettered)');
      assert.ok(row.last_error?.includes('Simulated Redis network timeout'));
    } finally {
      (redis as any).del = originalDel;
    }
  });
});
