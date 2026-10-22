import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

const BASE_URL = 'http://localhost:3000';

async function main() {
  console.log('--- Testing Atomic Logout-All with Generation Increment ---\n');

  const redisClient = createClient();
  await redisClient.connect();

  const uniqueId = randomUUID().slice(0, 8);
  const userPayload = {
    organisationName: `Org ${uniqueId}`,
    slug: `org-${uniqueId}`,
    name: `User ${uniqueId}`,
    email: `atomic-${uniqueId}@example.com`,
    password: 'SecurePassword123!',
  };

  // 1. Register test user
  console.log('Registering test user...');
  const regRes = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(userPayload),
  });
  if (!regRes.ok) throw new Error(`Registration failed: ${regRes.status}`);

  // Helper to decode JWT
  const decodeJwt = (tok: string) => JSON.parse(Buffer.from(tok.split('.')[1]!, 'base64').toString());

  // Helper to login
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

  // Helper to check protected endpoint
  const checkProtected = async (token: string, label: string) => {
    const res = await fetch(`${BASE_URL}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    console.log(`  [${label}] GET /v1/auth/me -> Status: ${res.status}`, body);
    return { status: res.status, body };
  };

  // 2. Log in twice (Device A and Device B)
  console.log('\nStep 1: Logging in twice (Generation 0)...');
  const tokenA = await login('Login A');
  const tokenB = await login('Login B');

  const payloadA = decodeJwt(tokenA);
  const payloadB = decodeJwt(tokenB);
  const userId = payloadA.sub;

  console.log('  Token A session ID:', payloadA.sid);
  console.log('  Token B session ID:', payloadB.sid);

  const initA = await checkProtected(tokenA, 'Token A');
  const initB = await checkProtected(tokenB, 'Token B');
  if (initA.status !== 200 || initB.status !== 200) {
    throw new Error('Initial protected endpoint check failed');
  }

  // Check initial Redis version
  const initialVersion = await redisClient.get(`user-session-version:${userId}`);
  console.log('  Initial user-session-version in Redis:', initialVersion ?? 'nil (defaults to 0)');

  // 3. Call logout-all with Token B
  console.log('\nStep 2: Calling POST /v1/auth/logout-all with Token B...');
  const logoutAllRes = await fetch(`${BASE_URL}/v1/auth/logout-all`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  console.log(`  POST /v1/auth/logout-all -> Status: ${logoutAllRes.status}`, await logoutAllRes.json());
  if (logoutAllRes.status !== 200) throw new Error('Logout-all failed');

  // Verify Redis version incremented to 1
  const versionAfterLogout = await redisClient.get(`user-session-version:${userId}`);
  console.log('  user-session-version in Redis after logout-all:', versionAfterLogout);
  if (versionAfterLogout !== '1') {
    throw new Error(`Expected version 1, but got ${versionAfterLogout}`);
  }
  console.log('  Confirmed: Version atomically incremented to 1.');

  // Verify sessions and set are deleted in Redis
  const sessionAExists = await redisClient.exists(`session:${payloadA.sid}`);
  const sessionBExists = await redisClient.exists(`session:${payloadB.sid}`);
  const setExists = await redisClient.exists(`user-sessions:${userId}`);
  console.log(`  session:A exists? ${sessionAExists === 1}`);
  console.log(`  session:B exists? ${sessionBExists === 1}`);
  console.log(`  user-sessions set exists? ${setExists === 1}`);

  // 4. Confirm both tokens now receive 401
  console.log('\nStep 3: Confirming both tokens now receive 401 on protected endpoint...');
  const postA = await checkProtected(tokenA, 'Token A');
  const postB = await checkProtected(tokenB, 'Token B');
  if (postA.status !== 401 || postB.status !== 401) {
    throw new Error('Expected both tokens to receive 401');
  }
  console.log('  Confirmed: Both older generation tokens are unauthorized (401).');

  // 5. Log in again (Device C - Generation 1)
  console.log('\nStep 4: Logging in again (should obtain Generation 1)...');
  const tokenC = await login('Login C');
  const payloadC = decodeJwt(tokenC);
  console.log('  Token C session ID:', payloadC.sid);

  const rawSessionC = await redisClient.get(`session:${payloadC.sid}`);
  console.log('  session record in Redis for Token C:', rawSessionC);
  const sessionCObj = JSON.parse(rawSessionC!);
  if (sessionCObj.sessionVersion !== 1) {
    throw new Error(`Expected sessionVersion 1, got ${sessionCObj.sessionVersion}`);
  }
  console.log('  Confirmed: Token C session was created with sessionVersion = 1.');

  // Confirm Token C works
  const checkC = await checkProtected(tokenC, 'Token C');
  if (checkC.status !== 200) {
    throw new Error(`Expected Token C to return 200, got ${checkC.status}`);
  }
  console.log('  Confirmed: Token C works on protected endpoint (200 OK).');

  // And old tokens still fail
  const recheckA = await checkProtected(tokenA, 'Token A');
  if (recheckA.status !== 401) throw new Error('Old token A should still be 401');

  await redisClient.quit();
  console.log('\nAll atomic logout-all and generation increment tests passed successfully!');
}

main().catch(err => {
  console.error('\nTest failed:', err);
  process.exit(1);
});
