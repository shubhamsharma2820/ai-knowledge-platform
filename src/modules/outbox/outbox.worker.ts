import { randomUUID } from 'node:crypto';
import { pool } from '../../db/database.js';
import { redis } from '../../db/redis.js';

export const workerId =
  process.env.WORKER_ID ?? `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

export type ClaimedEvent = {
  id: string;
  event_type: string;
  aggregate_id: string;
  payload?: unknown;
};

export async function claimOutboxBatch(
  batchSize = 10,
  claimTimeoutMinutes = 2,
): Promise<ClaimedEvent[]> {
  const result = await pool.query<ClaimedEvent>(
    `UPDATE outbox_events
     SET claimed_at = NOW(),
         claimed_by = $1
     WHERE id IN (
       SELECT id
       FROM outbox_events
       WHERE processed_at IS NULL
         AND failed_at IS NULL
         AND next_attempt_at <= NOW()
         AND (
           claimed_at IS NULL
           OR claimed_at < NOW() - ($2 || ' minutes')::INTERVAL
         )
       ORDER BY next_attempt_at, id
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, event_type, aggregate_id`,
    [workerId, String(claimTimeoutMinutes), batchSize],
  );

  return result.rows;
}

export async function processOutboxBatch(
  batchSize = 10,
): Promise<number> {
  const events = await claimOutboxBatch(batchSize);
  let processed = 0;

  for (const event of events) {
    const success = await processClaimedEvent(event);

    if (success) {
      processed++;
    }
  }

  return processed;
}

export async function recordOutboxFailure(
  event: ClaimedEvent,
  error: unknown,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);

  console.error('Outbox event processing failed:', {
    eventId: event.id,
    error: errorMessage,
  });

  try {
    await pool.query(
      `UPDATE outbox_events
       SET attempts = attempts + 1,
           last_error = $3,
           failed_at = CASE
             WHEN attempts + 1 >= 5 THEN NOW()
             ELSE NULL
           END,
           next_attempt_at = CASE
             WHEN attempts + 1 >= 5 THEN next_attempt_at
             ELSE NOW() + (
               LEAST(
                 16,
                 POWER(2, attempts)
               ) * INTERVAL '1 second'
             )
           END,
           claimed_at = NULL,
           claimed_by = NULL
       WHERE id = $1
         AND claimed_by = $2
         AND processed_at IS NULL`,
      [event.id, workerId, errorMessage],
    );
  } catch (releaseError) {
    console.error('Failed to record outbox failure:', releaseError);
  }
}

export async function processClaimedEvent(
  event: ClaimedEvent,
): Promise<boolean> {
  if (event.event_type !== 'organisation.cache_invalidate') {
    await recordOutboxFailure(
      event,
      new Error(`Unsupported outbox event type: ${event.event_type}`),
    );
    return false;
  }

  try {
    // Network operation: no PostgreSQL transaction is open here.
    await redis.del(`organisation:${event.aggregate_id}`);

    const result = await pool.query(
      `UPDATE outbox_events
       SET processed_at = NOW(),
           attempts = attempts + 1,
           last_error = NULL,
           claimed_at = NULL,
           claimed_by = NULL
       WHERE id = $1
         AND claimed_by = $2
         AND processed_at IS NULL`,
      [event.id, workerId],
    );

    return result.rowCount === 1;
  } catch (error) {
    await recordOutboxFailure(event, error);
    return false;
  }
}