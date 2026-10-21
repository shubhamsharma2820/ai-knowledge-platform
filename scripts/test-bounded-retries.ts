import { pool } from '../src/db/database.js';
import { redis } from '../src/db/redis.js';
import { processOutboxBatch } from '../src/modules/outbox/outbox.worker.js';

async function main() {
  console.log('================================================================');
  console.log('   STEP 1: Inspect Current Outbox State (LIMIT 10)');
  console.log('================================================================');

  const initialRows = await pool.query(`
    SELECT
      id,
      event_type,
      attempts,
      next_attempt_at,
      last_error,
      processed_at,
      failed_at,
      claimed_by
    FROM outbox_events
    ORDER BY id DESC
    LIMIT 10;
  `);
  console.table(initialRows.rows);

  console.log('\n================================================================');
  console.log('   STEP 2: Create Controlled Failure (learning.unsupported_event)');
  console.log('================================================================');

  // Fetch a valid organisation UUID
  const orgResult = await pool.query<{ id: string }>(`SELECT id FROM organisation LIMIT 1;`);
  if (orgResult.rows.length === 0) {
    throw new Error('No organisation found in database.');
  }
  const orgId = orgResult.rows[0]!.id;

  const insertResult = await pool.query<{
    id: string;
    event_type: string;
    attempts: number;
    failed_at: string | null;
  }>(
    `INSERT INTO outbox_events (
       event_type,
       aggregate_id,
       payload
     )
     VALUES (
       'learning.unsupported_event',
       $1,
       '{}'::jsonb
     )
     RETURNING id, event_type, attempts, failed_at;`,
    [orgId],
  );

  const testEvent = insertResult.rows[0]!;
  console.log('Inserted test event:', testEvent);

  console.log('\n================================================================');
  console.log('   STEP 3: Run Bounded Retries (Attempts 1 to 5)');
  console.log('================================================================');

  // Ensure Redis is connected if worker attempts connection
  if (!redis.isOpen) {
    await redis.connect();
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    console.log(`\n--- Attempt ${attempt} ---`);

    // Ensure next_attempt_at is eligible for this controlled test run
    await pool.query(
      `UPDATE outbox_events
       SET next_attempt_at = NOW() - INTERVAL '1 millisecond'
       WHERE id = $1`,
      [testEvent.id],
    );

    // Run worker batch
    const processedCount = await processOutboxBatch(10);
    console.log(`Worker processOutboxBatch run. (Attempt: ${attempt}, Processed count: ${processedCount})`);

    // Inspect the event row
    const inspection = await pool.query(`
      SELECT
        id,
        attempts,
        next_attempt_at,
        last_error,
        processed_at,
        failed_at,
        claimed_at,
        claimed_by
      FROM outbox_events
      WHERE id = $1;
    `, [testEvent.id]);

    console.table(inspection.rows);
  }

  console.log('\n================================================================');
  console.log('   STEP 4: Verify Terminal Event Is Excluded From Future Claims');
  console.log('================================================================');

  // Reset next_attempt_at to past to prove it still won't be claimed because failed_at IS NOT NULL
  await pool.query(
    `UPDATE outbox_events
     SET next_attempt_at = NOW() - INTERVAL '1 minute'
     WHERE id = $1`,
    [testEvent.id],
  );

  const subsequentProcessed = await processOutboxBatch(10);
  console.log('Run after failed_at is populated. Processed count:', subsequentProcessed);

  const finalCheck = await pool.query(`
    SELECT id, attempts, failed_at, claimed_by
    FROM outbox_events
    WHERE id = $1;
  `, [testEvent.id]);
  console.log('Terminal event state in DB:', finalCheck.rows[0]);

  console.log('\n================================================================');
  console.log('   STEP 5: Monitor Pending, Processed, and Failed Events');
  console.log('================================================================');

  const monitorResult = await pool.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE processed_at IS NULL
          AND failed_at IS NULL
      ) AS pending_events,

      COUNT(*) FILTER (
        WHERE processed_at IS NOT NULL
      ) AS processed_events,

      COUNT(*) FILTER (
        WHERE failed_at IS NOT NULL
      ) AS failed_events,

      COUNT(*) FILTER (
        WHERE processed_at IS NULL
          AND failed_at IS NULL
          AND next_attempt_at > NOW()
      ) AS waiting_for_retry
    FROM outbox_events;
  `);

  console.table(monitorResult.rows);

  await redis.quit();
  await pool.end();
}

main().catch((err) => {
  console.error('Test run failed:', err);
  process.exit(1);
});
