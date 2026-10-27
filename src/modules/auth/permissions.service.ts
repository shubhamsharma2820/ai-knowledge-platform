
import { pool } from '../../db/database.js';
import { redis } from '../../db/redis.js'

export type Role = 'owner' | 'admin' | 'member';

const ROLE_CACHE_TTL_SECONDS = 60;

export async function invalidateUserRoleCache(
  userId: string,
  organisationId: string,
): Promise<void> {
  const cacheKey = `user-role:${organisationId}:${userId}`;

  try {
    await redis.del(cacheKey);
  } catch (error) {
    console.error('Role cache invalidation failed:', {
      error,
      userId,
      organisationId,
    });
  }
}

export async function getUserRole(
  userId: string,
  organisationId: string,
): Promise<Role | null> {
  const cacheKey = `user-role:${organisationId}:${userId}`;

  // Try Redis first. Redis is a cache, not the source of truth.
  try {
    const cachedRole = await redis.get(cacheKey);

    if (
      cachedRole === 'owner' ||
      cachedRole === 'admin' ||
      cachedRole === 'member'
    ) {
      return cachedRole;
    }
  } catch (error) {
    // Fall back to PostgreSQL for this cache read failure.
    console.error('Role cache read failed:', error);
  }

  const result = await pool.query<{ role: Role }>(
    `SELECT role
     FROM users
     WHERE id = $1
       AND organisation_id = $2
       AND is_active = 1
       AND is_deleted = 0
     LIMIT 1`,
    [userId, organisationId],
  );

  const role = result.rows[0]?.role ?? null;

  if (role !== null) {
    try {
      await redis.set(cacheKey, role, {
        EX: ROLE_CACHE_TTL_SECONDS,
      });
    } catch (error) {
      console.error('Role cache write failed:', error);
    }
  }

  return role;
}

export async function updateUserRole(
  userId: string,
  organisationId: string,
  newRole: Role,
): Promise<Role | null> {
  const result = await pool.query<{ role: Role }>(
    `UPDATE users
     SET role = $1
     WHERE id = $2
       AND organisation_id = $3
       AND is_active = 1
       AND is_deleted = 0
     RETURNING role`,
    [newRole, userId, organisationId],
  );

  const updatedRole = result.rows[0]?.role ?? null;

  if (!updatedRole) {
    return null;
  }

  await invalidateUserRoleCache(userId, organisationId);

  return updatedRole;
}

