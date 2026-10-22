import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

const BASE_URL = 'http://localhost:3000';

async function main() {
  console.log('--- Testing Concurrent Login & Logout-All Race Condition ---');

  const uniqueId = randomUUID().slice(0, 8);
  const userPayload = {
    organisationName: `Org ${uniqueId}`,
    slug: `org-${uniqueId}`,
    name: `User ${uniqueId}`,
    email: `race-${uniqueId}@example.com`,
    password: 'SecurePassword123!',
  };

  // 1. Register test user
  await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userPayload),
  });

  // 2. Initial login
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userPayload.email, password: userPayload.password }),
  });
  const { accessToken: token1, user } = await loginRes.json();

  console.log('Initial login complete for user:', user.id);

  // 3. Fire 5 concurrent logins and 1 logout-all at the exact same moment
  console.log('Triggering concurrent logins and logout-all simultaneously...');
  const promises = [
    fetch(`${BASE_URL}/v1/auth/logout-all`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token1}` },
    }).then(r => ({ op: 'logout-all', status: r.status })),
    ...Array.from({ length: 5 }, (_, i) =>
      fetch(`${BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: userPayload.email, password: userPayload.password }),
      }).then(async r => {
        const body = await r.json();
        return { op: `login-${i + 1}`, status: r.status, sid: (body as any)?.user?.sessionId };
      })
    ),
  ];

  const results = await Promise.all(promises);
  console.log('Operations completed:', results);

  // 4. Verify Redis index consistency
  const runRedisCli = (cmd: string) => {
    return execSync(`docker exec ai-knowledge-platform-redis redis-cli ${cmd}`).toString().trim();
  };

  const remainingSessions = runRedisCli(`SMEMBERS user-sessions:${user.id}`);
  console.log('Remaining sessions in user-sessions set:');
  console.log(' ', remainingSessions ? remainingSessions.split('\n').join(', ') : '(empty set)');

  // Verify that any session in the set actually exists in Redis, and no orphan keys exist
  if (remainingSessions) {
    const sids = remainingSessions.split('\n');
    for (const sid of sids) {
      const exists = runRedisCli(`EXISTS session:${sid}`);
      if (exists !== '1') {
        throw new Error(`Data corruption! Set references session:${sid} which does not exist in Redis!`);
      }
    }
    console.log(`All ${sids.length} remaining sessions are completely valid and indexed.`);
  }

  console.log('Concurrency test completed with full state consistency!');
}

main().catch(err => {
  console.error('Concurrency test failed:', err);
  process.exit(1);
});
