import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { createClient } from 'redis';
import { buildApp } from '../src/app.js';
import { redis } from '../src/db/redis.js';

const BASE_URL = 'http://localhost:3000';

function runRedisCli(cmd: string): string {
  return execSync(`docker exec ai-knowledge-platform-redis redis-cli ${cmd}`).toString().trim();
}

async function main() {
  console.log('--- Testing Authenticate Hook with Session Versioning & 503 Handling ---\n');

  const uniqueId = randomUUID().slice(0, 8);
  const userPayload = {
    organisationName: `Org ${uniqueId}`,
    slug: `org-${uniqueId}`,
    name: `User ${uniqueId}`,
    email: `auth-ver-${uniqueId}@example.com`,
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

  // Helper to decode JWT
  const decodeJwt = (tok: string) => JSON.parse(Buffer.from(tok.split('.')[1]!, 'base64').toString());

  // Log in
  console.log('Logging in...');
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: userPayload.email, password: userPayload.password }),
  });
  if (!loginRes.ok) throw new Error(`Login failed: ${loginRes.status}`);
  const { accessToken } = await loginRes.json();
  const payload = decodeJwt(accessToken);
  const sid = payload.sid;
  const userId = payload.sub;

  console.log('  Access token received for user:', userId);
  console.log('  Session ID:', sid);

  // Helper to call protected endpoint
  const callProtected = async () => {
    const res = await fetch(`${BASE_URL}/v1/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = await res.json();
    return { status: res.status, body };
  };

  const redisClient = createClient();
  await redisClient.connect();

  // --- Step 1: Log in and confirm the token works ---
  console.log('\nStep 1: Confirm token works on protected endpoint...');
  const step1 = await callProtected();
  console.log(`  GET /v1/auth/me -> Status: ${step1.status}`, step1.body);
  if (step1.status !== 200) {
    throw new Error(`Step 1 failed! Expected 200, got ${step1.status}`);
  }
  console.log('  Step 1 PASSED: Token is valid and returns 200 OK.');

  // --- Step 2: Delete its Redis session key; the token should receive 401 ---
  console.log('\nStep 2: Deleting Redis session key and testing token...');
  await redisClient.del(`session:${sid}`);
  console.log(`  Executed: DEL session:${sid}`);

  const step2 = await callProtected();
  console.log(`  GET /v1/auth/me -> Status: ${step2.status}`, step2.body);
  if (step2.status !== 401) {
    throw new Error(`Step 2 failed! Expected 401, got ${step2.status}`);
  }
  if (step2.body.message !== 'Session revoked or expired') {
    throw new Error(`Step 2 failed! Unexpected message: ${step2.body.message}`);
  }
  console.log('  Step 2 PASSED: Received 401 with "Session revoked or expired".');

  // --- Step 3: Restore a valid session, change its stored sessionVersion to a different number, and confirm 401 ---
  console.log('\nStep 3: Restoring session with mismatched sessionVersion...');
  // Current user version in Redis is 0, so set sessionVersion = 99
  const mismatchedSession = JSON.stringify({
    userId,
    organisationId: payload.organisationId,
    sessionVersion: 99,
  });
  await redisClient.set(`session:${sid}`, mismatchedSession, { EX: 900 });
  console.log(`  Restored session:${sid} with sessionVersion = 99 (current version is 0)`);

  const step3 = await callProtected();
  console.log(`  GET /v1/auth/me -> Status: ${step3.status}`, step3.body);
  if (step3.status !== 401) {
    throw new Error(`Step 3 failed! Expected 401, got ${step3.status}`);
  }
  if (step3.body.message !== 'Session invalid') {
    throw new Error(`Step 3 failed! Unexpected message: ${step3.body.message}`);
  }
  console.log('  Step 3 PASSED: Received 401 with "Session invalid".');

  // Restore the session to matching version (0)
  const validSession = JSON.stringify({
    userId,
    organisationId: payload.organisationId,
    sessionVersion: 0,
  });
  await redisClient.set(`session:${sid}`, validSession, { EX: 900 });
  console.log('  Restored session with valid sessionVersion = 0.');

  // --- Step 4: Temporarily make Redis unavailable and confirm authentication returns 503, not 401 ---
  console.log('\nStep 4: Testing Redis unavailable scenario (expecting 503 Service Unavailable)...');
  
  // Test 4A: via app.inject() with simulated Redis outage
  console.log('  [4A] Testing via Fastify injection with simulated Redis failure...');
  const app = buildApp();
  await app.ready();

  const originalGet = redis.get.bind(redis);
  // Simulate Redis outage by rejecting redis.get
  (redis as any).get = async () => {
    throw new Error('Connection lost: Redis is down');
  };

  try {
    const injectRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    console.log(`  Fastify inject response -> Status: ${injectRes.statusCode}`, injectRes.json());
    if (injectRes.statusCode !== 503) {
      throw new Error(`Step 4 failed! Expected 503, got ${injectRes.statusCode}`);
    }
    const injectBody = injectRes.json();
    if (injectBody.message !== 'Authentication temporarily unavailable') {
      throw new Error(`Step 4 failed! Unexpected message: ${injectBody.message}`);
    }
    console.log('  [4A] PASSED: Received 503 with "Authentication temporarily unavailable".');
  } finally {
    // Restore original redis.get
    (redis as any).get = originalGet;
    await app.close();
  }

  // Test 4B: Live server test by pausing and unpausing Redis container
  console.log('  [4B] Testing live server with paused Redis container...');
  try {
    execSync('docker pause ai-knowledge-platform-redis');
    console.log('  Docker Redis container paused.');

    // We make a request with a short timeout to observe 503 or catch error
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    try {
      const liveRes = await fetch(`${BASE_URL}/v1/auth/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      console.log(`  Live response while paused -> Status: ${liveRes.status}`);
    } catch (e: any) {
      clearTimeout(timeoutId);
      console.log('  Request timed out or threw as expected while Redis is paused:', e.name || e.message);
    }
  } finally {
    execSync('docker unpause ai-knowledge-platform-redis');
    console.log('  Docker Redis container unpaused.');
  }

  // Confirm server recovers cleanly after Redis is unpaused
  const recoverCheck = await callProtected();
  console.log(`  GET /v1/auth/me after recovery -> Status: ${recoverCheck.status}`, recoverCheck.body);
  if (recoverCheck.status !== 200) {
    throw new Error('Server did not recover after Redis was unpaused');
  }
  await redisClient.quit();

  console.log('\nAll 4 verification steps passed successfully!');
}

main().catch(err => {
  console.error('\nVerification failed:', err);
  process.exit(1);
});
