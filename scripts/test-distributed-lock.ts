import { randomUUID } from 'node:crypto';
import { redis } from '../src/db/redis.js';
import { acquireOrganisationLock } from '../src/modules/organisation/lock.service.js';

async function main() {
  console.log('--- Testing Distributed Lock Acquisition (SET NX EX) ---\n');

  if (!redis.isOpen) {
    await redis.connect();
  }

  const testOrgId = randomUUID();
  const lockKey = `lock:organisation:${testOrgId}`;
  const ttlSeconds = 2; // Using 2 seconds for responsive test execution

  console.log(`Test Organisation ID: ${testOrgId}`);
  console.log(`Lock Key: ${lockKey}`);
  console.log(`Lock TTL: ${ttlSeconds} seconds\n`);

  // --- Case 1: Instance A acquires the lock and receives 'OK' ---
  console.log('Case 1: Instance A attempts to acquire lock...');
  const instanceA = await acquireOrganisationLock(testOrgId, ttlSeconds);
  console.log('  Instance A result:', instanceA);

  if (instanceA.acquired !== 'OK') {
    throw new Error(`Case 1 failed! Expected 'OK', got ${instanceA.acquired}`);
  }
  if (!instanceA.lockToken) {
    throw new Error('Case 1 failed! Missing lockToken');
  }

  const redisStoredToken = await redis.get(lockKey);
  console.log(`  Redis stored token: ${redisStoredToken}`);
  if (redisStoredToken !== instanceA.lockToken) {
    throw new Error(`Redis token mismatch! Stored: ${redisStoredToken}, expected: ${instanceA.lockToken}`);
  }
  console.log('  Case 1 PASSED: Instance A successfully acquired lock with "OK".\n');

  // --- Case 2: Instance B attempts to acquire the same lock and receives null ---
  console.log('Case 2: Instance B attempts to acquire the same lock concurrently...');
  const instanceBInitial = await acquireOrganisationLock(testOrgId, ttlSeconds);
  console.log('  Instance B result:', instanceBInitial);

  if (instanceBInitial.acquired !== null) {
    throw new Error(`Case 2 failed! Expected null, got ${instanceBInitial.acquired}`);
  }

  const redisTokenStillA = await redis.get(lockKey);
  if (redisTokenStillA !== instanceA.lockToken) {
    throw new Error('Instance B somehow modified or overwrote Instance A token!');
  }
  console.log('  Case 2 PASSED: Instance B received null; lock remains held by Instance A.\n');

  // --- Case 3: After the lock expires, Instance B can acquire it ---
  console.log(`Case 3: Waiting ${ttlSeconds + 0.5} seconds for lock to expire...`);
  await new Promise((resolve) => setTimeout(resolve, (ttlSeconds + 0.5) * 1000));

  const redisTokenAfterExpiry = await redis.get(lockKey);
  console.log(`  Redis key after expiry: ${redisTokenAfterExpiry} (expected null)`);
  if (redisTokenAfterExpiry !== null) {
    throw new Error(`Lock did not expire in time! Found: ${redisTokenAfterExpiry}`);
  }

  console.log('  Instance B attempts to acquire expired lock...');
  const instanceBAfterExpiry = await acquireOrganisationLock(testOrgId, ttlSeconds);
  console.log('  Instance B result:', instanceBAfterExpiry);

  if (instanceBAfterExpiry.acquired !== 'OK') {
    throw new Error(`Case 3 failed! Expected 'OK' after expiry, got ${instanceBAfterExpiry.acquired}`);
  }
  if (instanceBAfterExpiry.lockToken === instanceA.lockToken) {
    throw new Error('Case 3 failed! Lock token should be newly generated for Instance B');
  }

  const redisNewToken = await redis.get(lockKey);
  console.log(`  Redis stored token for Instance B: ${redisNewToken}`);
  if (redisNewToken !== instanceBAfterExpiry.lockToken) {
    throw new Error('Redis does not match Instance B token');
  }
  console.log('  Case 3 PASSED: After TTL expiry, Instance B successfully acquired the lock.\n');

  // Clean up
  await redis.del(lockKey);
  await redis.quit();

  console.log('All 3 lock acquisition test cases passed successfully!');
}

main().catch((err) => {
  console.error('\nTest failed:', err);
  process.exit(1);
});
