import { pool } from '../../db/database.js';
import { redis } from '../../db/redis.js';

type Organisation = {
  id: string;
  name: string;
  slug: string;
};

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

  // 2. Cache miss or Redis unavailable: read PostgreSQL as primary source of truth.
  const result = await pool.query<Organisation>(
    `SELECT id, name, slug
     FROM organisation
     WHERE id = $1
     LIMIT 1`,
    [id],
  );

  const organisation = result.rows[0] ?? null;

  // 3. Cache only successful lookups with error boundary.
  if (organisation !== null) {
    try {
      if (redis.isOpen) {
        await redis.set(cacheKey, JSON.stringify(organisation), {
          EX: 60,
        });
      }
    } catch (error) {
      // Fail-open: If Redis write fails, log warning without breaking the user request.
      console.warn(`[Redis Cache Write Error] Failed to cache key "${cacheKey}":`, error);
    }
  }

  return organisation;
}