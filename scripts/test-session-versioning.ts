import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

const BASE_URL = 'http://localhost:3000';

function runRedisCli(cmd: string): string {
  return execSync(`docker exec ai-knowledge-platform-redis redis-cli ${cmd}`).toString().trim();
}

async function main() {
  console.log('--- Testing Session Versioning on Login ---');

  const uniqueId = randomUUID().slice(0, 8);
  const userPayload = {
    organisationName: `Org ${uniqueId}`,
    slug: `org-${uniqueId}`,
    name: `User ${uniqueId}`,
    email: `version-${uniqueId}@example.com`,
    password: 'SecurePassword123!',
  };

  // Register user
  console.log('Registering test user...');
  const regRes = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userPayload),
  });
  if (!regRes.ok) throw new Error(`Registration failed: ${regRes.status}`);

  // Helper function to decode JWT claims
  const decodeJwt = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64').toString());

  // Helper function to log in
  const login = async (label: string) => {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userPayload.email, password: userPayload.password }),
    });
    if (!res.ok) throw new Error(`${label} failed: ${res.status}`);
    const data = await res.json();
    return data.accessToken as string;
  };

  // 1. Log in twice
  console.log('\n1. Logging in twice...');
  const tokenA = await login('Login 1');
  const tokenB = await login('Login 2');

  const payloadA = decodeJwt(tokenA);
  const payloadB = decodeJwt(tokenB);
  const userId = payloadA.sub;
  const sidA = payloadA.sid;
  const sidB = payloadB.sid;

  console.log('  Token A sid:', sidA);
  console.log('  Token B sid:', sidB);
  console.log('  User ID:', userId);

  // 2. Inspect each session record and verify sessionVersion is present
  console.log('\n2. Inspecting session records in Redis...');
  const rawSessionA = runRedisCli(`GET session:${sidA}`);
  const rawSessionB = runRedisCli(`GET session:${sidB}`);

  console.log(`  session:${sidA} ->`, rawSessionA);
  console.log(`  session:${sidB} ->`, rawSessionB);

  const sessionObjA = JSON.parse(rawSessionA);
  const sessionObjB = JSON.parse(rawSessionB);

  if (typeof sessionObjA.sessionVersion !== 'number') {
    throw new Error(`sessionVersion missing or not a number in session A: ${rawSessionA}`);
  }
  if (typeof sessionObjB.sessionVersion !== 'number') {
    throw new Error(`sessionVersion missing or not a number in session B: ${rawSessionB}`);
  }
  console.log(`  Verified: sessionVersion is present (A: ${sessionObjA.sessionVersion}, B: ${sessionObjB.sessionVersion})`);

  // 3. Verify both IDs are in user-sessions:<userId>
  console.log(`\n3. Verifying user-sessions:${userId} in Redis...`);
  const setMembersRaw = runRedisCli(`SMEMBERS user-sessions:${userId}`);
  const setMembers = setMembersRaw.split('\n').map(s => s.trim());
  console.log('  user-sessions members:', setMembers);

  if (!setMembers.includes(sidA)) {
    throw new Error(`Session ID A (${sidA}) is not in user-sessions set!`);
  }
  if (!setMembers.includes(sidB)) {
    throw new Error(`Session ID B (${sidB}) is not in user-sessions set!`);
  }
  console.log('  Verified: Both session IDs are present in user-sessions set.');

  // 4. Confirm both tokens still work on protected endpoints
  console.log('\n4. Confirming both tokens work on protected endpoint (/v1/auth/me)...');
  const checkProtected = async (token: string, label: string) => {
    const res = await fetch(`${BASE_URL}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    console.log(`  ${label} GET /v1/auth/me -> Status: ${res.status}`, body);
    return res.status;
  };

  const statusA = await checkProtected(tokenA, 'Token A');
  const statusB = await checkProtected(tokenB, 'Token B');

  if (statusA !== 200) throw new Error(`Token A failed with status ${statusA}`);
  if (statusB !== 200) throw new Error(`Token B failed with status ${statusB}`);

  console.log('\nAll 4 test steps passed successfully!');
}

main().catch(err => {
  console.error('\nTest failed:', err);
  process.exit(1);
});
