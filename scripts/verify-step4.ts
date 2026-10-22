import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

const BASE_URL = 'http://localhost:3000';

async function main() {
  console.log('--- Step 4 Verification: Session Revocation Behavior ---');

  // Setup: Register a unique test user
  const uniqueId = randomUUID().slice(0, 8);
  const userPayload = {
    organisationName: `Org ${uniqueId}`,
    slug: `org-${uniqueId}`,
    name: `User ${uniqueId}`,
    email: `test-${uniqueId}@example.com`,
    password: 'SecurePassword123!',
  };

  console.log(`Registering test user: ${userPayload.email}`);
  const regRes = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userPayload),
  });

  if (!regRes.ok) {
    throw new Error(`Registration failed: ${regRes.status} ${await regRes.text()}`);
  }
  console.log('Registration succeeded (201 Created).');

  // 1. Log in twice and save both access tokens
  console.log('\n1. Logging in twice to obtain Token A and Token B...');
  const login = async () => {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: userPayload.email,
        password: userPayload.password,
      }),
    });
    if (!res.ok) throw new Error(`Login failed: ${res.status}`);
    const data = await res.json();
    return data.accessToken as string;
  };

  const tokenA = await login();
  console.log('  Token A received:', tokenA.slice(0, 25) + '...');
  const tokenB = await login();
  console.log('  Token B received:', tokenB.slice(0, 25) + '...');

  // Decode tokens to inspect claims
  const decodeJwt = (tok: string) => JSON.parse(Buffer.from(tok.split('.')[1]!, 'base64').toString());
  const payloadA = decodeJwt(tokenA);
  const payloadB = decodeJwt(tokenB);
  console.log('  Token A claims:', { sub: payloadA.sub, sid: payloadA.sid });
  console.log('  Token B claims:', { sub: payloadB.sub, sid: payloadB.sid });

  // Helper to inspect Redis directly
  const runRedisCli = (cmd: string) => {
    return execSync(`docker exec ai-knowledge-platform-redis redis-cli ${cmd}`).toString().trim();
  };

  console.log('  Redis user-sessions set members after 2 logins:');
  console.log('   ', runRedisCli(`SMEMBERS user-sessions:${payloadA.sub}`).split('\n').join(', '));
  console.log('  Redis session:sid_A exists?', runRedisCli(`EXISTS session:${payloadA.sid}`) === '1');
  console.log('  Redis session:sid_B exists?', runRedisCli(`EXISTS session:${payloadB.sid}`) === '1');

  // Helper to check protected endpoint (/v1/auth/me)
  const checkProtected = async (token: string, tokenLabel: string) => {
    const res = await fetch(`${BASE_URL}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    console.log(`  [${tokenLabel}] GET /v1/auth/me -> Status: ${res.status}`, body);
    return { status: res.status, body };
  };

  // Verify both tokens work initially
  console.log('\nSanity check: verifying both tokens work initially:');
  const initA = await checkProtected(tokenA, 'Token A');
  if (initA.status !== 200) throw new Error('Token A failed initial check');
  const initB = await checkProtected(tokenB, 'Token B');
  if (initB.status !== 200) throw new Error('Token B failed initial check');

  // 2. Call /v1/auth/logout with token A
  console.log('\n2. Calling POST /v1/auth/logout with Token A...');
  const logoutResA = await fetch(`${BASE_URL}/v1/auth/logout`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  console.log(`  POST /v1/auth/logout -> Status: ${logoutResA.status}`, await logoutResA.json());
  if (logoutResA.status !== 200) throw new Error('Logout with Token A failed');

  console.log('  Redis state after logout with Token A:');
  console.log('  Redis session:sid_A exists?', runRedisCli(`EXISTS session:${payloadA.sid}`) === '1');
  console.log('  Redis session:sid_B exists?', runRedisCli(`EXISTS session:${payloadB.sid}`) === '1');
  console.log('  Redis user-sessions set members:', runRedisCli(`SMEMBERS user-sessions:${payloadA.sub}`).split('\n').join(', '));

  // 3. Confirm token A receives 401 on a protected endpoint, while token B still works
  console.log('\n3. Confirming Token A receives 401 on protected endpoint, while Token B still works:');
  const postLogoutA = await checkProtected(tokenA, 'Token A');
  if (postLogoutA.status !== 401) {
    throw new Error(`Expected Token A to receive 401, but got ${postLogoutA.status}`);
  }
  console.log('  Confirmed: Token A received 401 Unauthorized.');

  const postLogoutB = await checkProtected(tokenB, 'Token B');
  if (postLogoutB.status !== 200) {
    throw new Error(`Expected Token B to receive 200, but got ${postLogoutB.status}`);
  }
  console.log('  Confirmed: Token B still works (200 OK).');

  // 4. Call /v1/auth/logout-all with token B
  console.log('\n4. Calling POST /v1/auth/logout-all with Token B...');
  const logoutAllResB = await fetch(`${BASE_URL}/v1/auth/logout-all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  console.log(`  POST /v1/auth/logout-all -> Status: ${logoutAllResB.status}`, await logoutAllResB.json());
  if (logoutAllResB.status !== 200) throw new Error('Logout-all with Token B failed');

  console.log('  Redis state after logout-all with Token B:');
  console.log('  Redis session:sid_B exists?', runRedisCli(`EXISTS session:${payloadB.sid}`) === '1');
  console.log('  Redis user-sessions set exists?', runRedisCli(`EXISTS user-sessions:${payloadA.sub}`) === '1');

  // 5. Confirm token B also receives 401 on a protected endpoint
  console.log('\n5. Confirming Token B also receives 401 on protected endpoint:');
  const postLogoutAllB = await checkProtected(tokenB, 'Token B');
  if (postLogoutAllB.status !== 401) {
    throw new Error(`Expected Token B to receive 401, but got ${postLogoutAllB.status}`);
  }
  console.log('  Confirmed: Token B received 401 Unauthorized.');

  // Also verify token A still receives 401
  const postLogoutAllA = await checkProtected(tokenA, 'Token A');
  if (postLogoutAllA.status !== 401) {
    throw new Error(`Expected Token A to receive 401, but got ${postLogoutAllA.status}`);
  }

  console.log('\nAll 5 verification steps passed successfully!');
}

main().catch((err) => {
  console.error('\nVerification failed:', err);
  process.exit(1);
});
