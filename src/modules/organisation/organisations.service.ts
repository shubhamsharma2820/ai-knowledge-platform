import { pool } from '../../db/database.js';
import { redis } from '../../db/redis.js';
export { acquireOrganisationLock, acquireLock, type LockAcquisition } from './lock.service.js';

type Organisation = {
  id: string;
  name: string;
  slug: string;
  cache_version: string | number;
};

// In-flight map for promise coalescing / singleflight deduplication
const inFlightRequests = new Map<string, Promise<Organisation | null>>();

// Diagnostic counter to measure database lookups
export let dbLookupCount = 0;
export function resetDbLookupCount() {
  dbLookupCount = 0;
}

export async function getOrganisationById(
  id: string,
): Promise<Organisation | null> {
  const cacheKey = `organisation:${id}`;

  // 1. Try Redis first with graceful fallback.
  try {
    if (redis.isOpen) {
      const cached = await redis.get(cacheKey);
      if (cached !== null) {
        return JSON.parse(cached) as Organisation;
      }
    }
  } catch (error) {
    // Fail-open: If Redis is unavailable, log a warning and fall back to PostgreSQL.
    console.warn(`[Redis Cache Read Error] Failed to read key "${cacheKey}":`, error);
  }

  // 2. Coalesce concurrent requests (Shared-Promise / In-flight Deduplication)
  const existingInFlight = inFlightRequests.get(id);
  if (existingInFlight) {
    return existingInFlight;
  }

  // 3. Create shared promise for DB lookup & cache population
  const lookupPromise = (async () => {
    try {
      dbLookupCount++;
      // Cache miss or Redis unavailable: read PostgreSQL as primary source of truth.
      const result = await pool.query<Organisation>(
        `SELECT id, name, slug, cache_version
         FROM organisation
         WHERE id = $1
         LIMIT 1`,
        [id],
      );

      const organisation = result.rows[0] ?? null;

      // Cache only successful lookups with error boundary.
      if (organisation !== null) {
        try {
          if (redis.isOpen) {
            const versionKey = `organisation:${id}:version`;
            // Atomic version-checked cache write using Redis Lua script:
            // Only set if current recorded version in Redis <= record's cache_version.
            // If an update has already incremented the version, discard the stale write.
            const writeScript = `
              local currentVersion = redis.call('get', KEYS[2])
              if currentVersion and tonumber(currentVersion) > tonumber(ARGV[2]) then
                return 0
              end
              redis.call('set', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))
              redis.call('set', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[4]))
              return 1
            `;
            await redis.eval(writeScript, {
              keys: [cacheKey, versionKey],
              arguments: [
                JSON.stringify(organisation),
                String(organisation.cache_version ?? '1'),
                '60',
                '300',
              ],
            });
          }
        } catch (error) {
          // Fail-open: If Redis write fails, log warning without breaking the user request.
          console.warn(`[Redis Cache Write Error] Failed to cache key "${cacheKey}":`, error);
        }
      }

      return organisation;
    } finally {
      // Ensure the in-flight promise is removed once settled
      inFlightRequests.delete(id);
    }
  })();

  inFlightRequests.set(id, lookupPromise);
  return lookupPromise;
}

export async function updateOrganisation(
  id: string,
  input: { name: string },
): Promise<Organisation | null> {
  const client = await pool.connect();
  let organisation: Organisation | null = null;

  try {
    await client.query('BEGIN');

    const result = await client.query<Organisation>(
      `UPDATE organisation
SET
  name = $2,
  cache_version = cache_version + 1,
  updated_at = NOW()
WHERE id = $1
RETURNING id, name, slug, cache_version;`,
      [id, input.name],
    );

    organisation = result.rows[0] ?? null;

    if (organisation) {
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_id, payload)
         VALUES ('organisation.cache_invalidate', $1::UUID, jsonb_build_object('organisationId', $1::TEXT))`,
        [id],
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  if (!organisation) {
    return null;
  }

  // Post-commit cache invalidation: executed strictly after PostgreSQL transaction has committed
  try {
    if (redis.isOpen) {
      await redis.set(`organisation:${id}:version`, String(organisation.cache_version), {
        EX: 300,
      });
    }
    await redis.del(`organisation:${id}`);
  } catch (error) {
    console.error('Organisation cache invalidation failed:', error);
  }

  return organisation;
}