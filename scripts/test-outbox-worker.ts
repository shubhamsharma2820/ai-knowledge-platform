import { pool } from '../src/db/database.js';
import { redis } from '../src/db/redis.js';
import { processOutboxBatch } from '../src/modules/outbox/outbox.worker.js';

async function main() {
  console.log('======================================================');
  console.log('   Testing Outbox Worker Lifecycle (Claim → Invalidate → Acknowledge)');
  console.log('======================================================\n');

  // 1. Ensure Redis is connected
  if (!redis.isOpen) {
    await redis.connect();
  }

  // 2. Choose or seed test organisation
  const orgResult = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM organisation LIMIT 1;`,
  );
  if (orgResult.rows.length === 0) {
    throw new Error('No organisation found in database to test.');
  }
  const orgId = orgResult.rows[0]!.id;
  const orgName = orgResult.rows[0]!.name;
  const cacheKey = `organisation:${orgId}`;

  console.log(`[Step 1] Target Organisation: "${orgName}" (${orgId})`);

  // Pre-seed Redis cache key to confirm it gets invalidated
  await redis.set(cacheKey, JSON.stringify({ id: orgId, name: orgName, cached: true }), {
    EX: 120,
  });
  const cachedBefore = await redis.get(cacheKey);
  console.log(`[Step 2] Seeded Redis cache key: "${cacheKey}" ->`, cachedBefore !== null ? 'EXISTS' : 'MISSING');

  // 3. Insert outbox event
  console.log('\n[Step 3] Inserting outbox event into PostgreSQL:');
  const insertResult = await pool.query<{
    id: string;
    event_type: string;
    aggregate_id: string;
    processed_at: string | null;
  }>(
    `INSERT INTO outbox_events (
       event_type,
       aggregate_id,
       payload
     )
     VALUES (
       'organisation.cache_invalidate',
       $1::UUID,
       jsonb_build_object(
         'organisationId',
         $1::TEXT
       )
     )
     RETURNING id, event_type, aggregate_id, processed_at;`,
    [orgId],
  );

  const insertedEvent = insertResult.rows[0]!;
  console.log('  Inserted Event:', insertedEvent);

  // 4. Run the worker once
  console.log('\n[Step 4] Running processOutboxBatch(10)...');
  const processed = await processOutboxBatch(10);
  console.log('  Worker execution result:', { processed });

  // 5. Verify the event in PostgreSQL
  console.log('\n[Step 5] Checking event state in PostgreSQL:');
  const checkResult = await pool.query(
    `SELECT id, attempts, processed_at, claimed_at, claimed_by
     FROM outbox_events
     ORDER BY id DESC
     LIMIT 5;`,
  );
  console.table(checkResult.rows);

  // 6. Verify Redis cache deletion
  const cachedAfter = await redis.get(cacheKey);
  console.log('\n[Step 6] Verifying Redis key deletion:');
  console.log(`  Key "${cacheKey}":`, cachedAfter === null ? 'DELETED (null)' : 'STILL EXISTS (FAILED)');

  // Assert expectations
  const eventInDb = checkResult.rows.find((r: any) => String(r.id) === String(insertedEvent.id));
  if (!eventInDb) {
    throw new Error('Could not find processed event in database.');
  }

  const processedAtOk = eventInDb.processed_at !== null;
  const attemptsOk = Number(eventInDb.attempts) === 1;
  const claimedNullOk = eventInDb.claimed_at === null && eventInDb.claimed_by === null;
  const cacheDeletedOk = cachedAfter === null;

  console.log('\n======================================================');
  console.log('                   VERIFICATION REPORT                ');
  console.log('======================================================');
  console.log('1. processed_at is populated:          ', processedAtOk ? 'PASSED' : 'FAILED');
  console.log('2. attempts is 1:                      ', attemptsOk ? 'PASSED' : 'FAILED');
  console.log('3. claimed_at and claimed_by are NULL: ', claimedNullOk ? 'PASSED' : 'FAILED');
  console.log('4. Redis cache key deleted:            ', cacheDeletedOk ? 'PASSED' : 'FAILED');
  console.log('======================================================');

  await redis.quit();
  await pool.end();

  if (processedAtOk && attemptsOk && claimedNullOk && cacheDeletedOk) {
    console.log('\n--> All lifecycle checks PASSED successfully!\n');
  } else {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Test script failed:', err);
  process.exit(1);
});
