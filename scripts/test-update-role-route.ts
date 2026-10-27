import { randomUUID } from 'node:crypto';
import { pool } from '../src/db/database.js';
import { redis } from '../src/db/redis.js';

const BASE_URL = 'http://localhost:3000';

async function main() {
  console.log('--- Testing Role Update HTTP Routes ---\n');

  if (!redis.isOpen) {
    await redis.connect();
  }

  const uniqueId = randomUUID().slice(0, 8);
  const ownerEmail = `owner-${uniqueId}@example.com`;
  const memberEmail = `member-${uniqueId}@example.com`;

  // 1. Register owner
  console.log('1. Registering Owner...');
  const regRes = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      organisationName: `Org ${uniqueId}`,
      slug: `org-${uniqueId}`,
      name: 'Owner User',
      email: ownerEmail,
      password: 'SecurePassword123!',
    }),
  });
  if (!regRes.ok) throw new Error(`Owner registration failed: ${regRes.status}`);

  // Login owner
  const loginOwnerRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password: 'SecurePassword123!' }),
  });
  const ownerData = await loginOwnerRes.json();
  const ownerToken = ownerData.accessToken as string;
  const orgId = (ownerData.user?.organisationId || (await pool.query('SELECT organisation_id FROM users WHERE email = $1', [ownerEmail])).rows[0]!.organisation_id) as string;

  console.log(`  Owner logged in: ${ownerData.user.id}, Org ID: ${orgId}`);

  // 2. Insert member user in the same organisation
  console.log('\n2. Creating Member user in the same organisation...');
  const memberInsert = await pool.query(
    `INSERT INTO users (organisation_id, name, email, password_hash, is_active, is_deleted, role)
     VALUES ($1, 'Member User', $2, 'dummy-hash', 1, 0, 'member')
     RETURNING id, role`,
    [orgId, memberEmail],
  );
  const memberId = memberInsert.rows[0]!.id;
  console.log(`  Member created: ${memberId} with initial role 'member'`);

  // Prime the Redis cache for member's role
  const cacheKey = `user-role:${orgId}:${memberId}`;
  await redis.set(cacheKey, 'member', { EX: 60 });
  console.log(`  Primed Redis cache: ${cacheKey} = 'member'`);

  // 3. Test PATCH /organisations/:orgId/users/:userId/role (promote member -> admin)
  console.log('\n3. Testing PATCH /organisations/:orgId/users/:userId/role (promote to admin)...');
  const patchAuthRes = await fetch(`${BASE_URL}/organisations/${orgId}/users/${memberId}/role`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ role: 'admin' }),
  });

  console.log(`  PATCH /organisations/:id/users/:userId/role -> Status: ${patchAuthRes.status}`);
  const patchAuthBody = await patchAuthRes.json();
  console.log('  Response:', patchAuthBody);

  if (patchAuthRes.status !== 200) {
    throw new Error(`Expected 200, got ${patchAuthRes.status}`);
  }
  if (patchAuthBody.role !== 'admin') {
    throw new Error(`Expected role 'admin', got ${patchAuthBody.role}`);
  }

  // Verify Redis cache key was deleted
  const cacheAfterPatch1 = await redis.get(cacheKey);
  console.log(`  Redis cache after update: ${cacheKey} = ${cacheAfterPatch1} (expected null)`);
  if (cacheAfterPatch1 !== null) {
    throw new Error('Cache key was not invalidated!');
  }
  console.log('  Confirmed: Role cache was invalidated successfully.');

  // 4. Test PATCH /organisations/:orgId/users/:userId/role (demote admin -> member)
  console.log('\n4. Testing PATCH /organisations/:orgId/users/:userId/role (demote to member)...');
  await redis.set(cacheKey, 'admin', { EX: 60 });
  console.log(`  Primed Redis cache with 'admin'`);

  const patchOrgRes = await fetch(`${BASE_URL}/organisations/${orgId}/users/${memberId}/role`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ role: 'member' }),
  });

  console.log(`  PATCH /organisations/:id/users/:userId/role -> Status: ${patchOrgRes.status}`);
  const patchOrgBody = await patchOrgRes.json();
  console.log('  Response:', patchOrgBody);

  if (patchOrgRes.status !== 200) {
    throw new Error(`Expected 200, got ${patchOrgRes.status}`);
  }
  if (patchOrgBody.role !== 'member') {
    throw new Error(`Expected role 'member', got ${patchOrgBody.role}`);
  }

  // Verify Redis cache was deleted again
  const cacheAfterPatch2 = await redis.get(cacheKey);
  console.log(`  Redis cache after update: ${cacheKey} = ${cacheAfterPatch2} (expected null)`);
  if (cacheAfterPatch2 !== null) {
    throw new Error('Cache key was not invalidated!');
  }

  // 5. Test invalid role rejection (Schema Validation)
  console.log('\n5. Testing validation rejection on invalid role...');
  const invalidRoleRes = await fetch(`${BASE_URL}/organisations/${orgId}/users/${memberId}/role`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ownerToken}`,
    },
    body: JSON.stringify({ role: 'super-admin-invalid' }),
  });
  console.log(`  PATCH with invalid role -> Status: ${invalidRoleRes.status} (expected 400)`);
  if (invalidRoleRes.status !== 400) {
    throw new Error(`Expected 400 Bad Request, got ${invalidRoleRes.status}`);
  }
  console.log('  Confirmed: Schema validation rejected invalid role.');

  // 6. Test unauthorized caller (no token)
  console.log('\n6. Testing unauthorized caller without token...');
  const noTokenRes = await fetch(`${BASE_URL}/organisations/${orgId}/users/${memberId}/role`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'admin' }),
  });
  console.log(`  PATCH without token -> Status: ${noTokenRes.status} (expected 401)`);
  if (noTokenRes.status !== 401) {
    throw new Error(`Expected 401, got ${noTokenRes.status}`);
  }
  console.log('  Confirmed: Unauthorized request blocked with 401.');

  await redis.quit();
  await pool.end();

  console.log('\nAll role update route tests passed successfully!');
}

main().catch(err => {
  console.error('\nTest failed:', err);
  process.exit(1);
});
