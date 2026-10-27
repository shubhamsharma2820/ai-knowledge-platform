import { randomUUID } from 'node:crypto';
import { pool } from '../src/db/database.js';
import { redis } from '../src/db/redis.js';
import { getUserRole, updateUserRole } from '../src/modules/auth/permissions.service.js';

async function main() {
  console.log('--- Testing User Role Caching and Invalidation ---\n');

  if (!redis.isOpen) {
    await redis.connect();
  }

  const uniqueId = randomUUID().slice(0, 8);
  const email = `role-test-${uniqueId}@example.com`;

  // 1. Create a test organisation and user in Postgres
  console.log('1. Setting up test organisation and user in PostgreSQL...');
  const orgResult = await pool.query(
    `INSERT INTO organisation (name, slug)
     VALUES ($1, $2)
     RETURNING id`,
    [`Org ${uniqueId}`, `org-${uniqueId}`],
  );
  const orgId = orgResult.rows[0]!.id;

  const userResult = await pool.query(
    `INSERT INTO users (organisation_id, name, email, password_hash, is_active, is_deleted, role)
     VALUES ($1, $2, $3, 'dummy-hash', 1, 0, 'member')
     RETURNING id, role`,
    [orgId, 'Test User', email],
  );
  const userId = userResult.rows[0]!.id;
  console.log(`  Created user ${userId} in org ${orgId} with initial role 'member'.`);

  const cacheKey = `user-role:${orgId}:${userId}`;

  // 2. Fetch role for the first time -> Cache Miss -> Cached in Redis
  console.log('\n2. Calling getUserRole() for the first time...');
  const initialCacheVal = await redis.get(cacheKey);
  console.log(`  Redis before call: ${cacheKey} = ${initialCacheVal}`);

  const role1 = await getUserRole(userId, orgId);
  console.log(`  getUserRole returned: '${role1}'`);
  if (role1 !== 'member') throw new Error(`Expected 'member', got ${role1}`);

  const cachedVal1 = await redis.get(cacheKey);
  console.log(`  Redis after call: ${cacheKey} = '${cachedVal1}'`);
  if (cachedVal1 !== 'member') throw new Error(`Expected Redis to cache 'member', got ${cachedVal1}`);
  console.log('  Confirmed: Role was cached in Redis with TTL.');

  // 3. Update user role -> Updates Postgres AND deletes Redis cache key
  console.log('\n3. Calling updateUserRole(userId, orgId, "admin")...');
  const updatedRole = await updateUserRole(userId, orgId, 'admin');
  console.log(`  updateUserRole returned: '${updatedRole}'`);
  if (updatedRole !== 'admin') throw new Error(`Expected 'admin', got ${updatedRole}`);

  // Verify Redis key was deleted
  const cacheAfterUpdate = await redis.get(cacheKey);
  console.log(`  Redis immediately after updateUserRole: ${cacheKey} = ${cacheAfterUpdate}`);
  if (cacheAfterUpdate !== null) {
    throw new Error(`Expected cache key to be deleted, but found: ${cacheAfterUpdate}`);
  }
  console.log('  Confirmed: Redis cache key was immediately deleted (invalidated).');

  // 4. Fetch role again -> Cache Miss -> Loads new role from DB -> Caches 'admin' in Redis
  console.log('\n4. Calling getUserRole() after role update...');
  const role2 = await getUserRole(userId, orgId);
  console.log(`  getUserRole returned: '${role2}'`);
  if (role2 !== 'admin') throw new Error(`Expected 'admin', got ${role2}`);

  const cachedVal2 = await redis.get(cacheKey);
  console.log(`  Redis after second call: ${cacheKey} = '${cachedVal2}'`);
  if (cachedVal2 !== 'admin') throw new Error(`Expected Redis to cache 'admin', got ${cachedVal2}`);
  console.log('  Confirmed: Fresh role loaded from PostgreSQL and re-cached in Redis as "admin".');

  await redis.quit();
  await pool.end();

  console.log('\nAll role caching and invalidation tests passed successfully!');
}

main().catch(err => {
  console.error('\nTest failed:', err);
  process.exit(1);
});
