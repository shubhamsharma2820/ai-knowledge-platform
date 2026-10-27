import { randomUUID } from 'node:crypto';
import { redis } from '../../db/redis.js';

export type LockAcquisition = {
  acquired: 'OK' | null;
  lockToken: string;
  lockKey: string;
};

export async function acquireOrganisationLock(
  organisationId: string,
  ttlSeconds = 5,
): Promise<LockAcquisition> {
  const lockKey = `lock:organisation:${organisationId}`;
  const lockToken = randomUUID();

  const result = await redis.set(lockKey, lockToken, {
    NX: true,
    EX: ttlSeconds,
  });

  return {
    acquired: result === 'OK' ? 'OK' : null,
    lockToken,
    lockKey,
  };
}

export const acquireLock = acquireOrganisationLock;
