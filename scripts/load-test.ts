process.env.NODE_ENV = 'test';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/database.js';
import { withTenantTransaction } from '../src/db/tenant-transaction.js';

interface LoadTestOptions {
  concurrency: number;
  durationSeconds: number;
}

interface RequestMetric {
  durationMs: number;
  statusCode: number;
  isError: boolean;
}

async function runLoadTest(options: LoadTestOptions) {
  const { concurrency, durationSeconds } = options;
  console.log(`\n======================================================`);
  console.log(`Starting Baseline Load Test (Day 3 Performance Checks)`);
  console.log(`Concurrency: ${concurrency} Virtual Users`);
  console.log(`Duration:    ${durationSeconds} seconds`);
  console.log(`Target:     GET /documents`);
  console.log(`======================================================\n`);

  // 1. Setup Test Data (Org, User, Documents)
  const app = buildApp();
  await app.ready();

  const orgSlug = `loadtest-org-${Date.now()}`;
  const orgResult = await pool.query(
    `INSERT INTO organisation (name, slug)
     VALUES ('LoadTest Org', $1)
     RETURNING id`,
    [orgSlug],
  );
  const orgId: string = orgResult.rows[0]!.id;

  const userResult = await pool.query(
    `INSERT INTO users (organisation_id, name, email, password_hash, is_active, is_deleted)
     VALUES ($1, 'Load Tester', $2, 'dummyhash', 1, 0)
     RETURNING id`,
    [orgId, `loadtest-${Date.now()}@example.com`],
  );
  const userId: string = userResult.rows[0]!.id;

  // Seed 25 documents for this tenant
  await withTenantTransaction(orgId, async (client) => {
    for (let i = 1; i <= 25; i++) {
      await client.query(
        `INSERT INTO knowledge_documents (organisation_id, title)
         VALUES ($1, $2)`,
        [orgId, `Document ${i} - Knowledge base article`],
      );
    }
  });

  const token = app.jwt.sign({ sub: userId, organisationId: orgId });

  // 2. Start HTTP dev server on an ephemeral port
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = address;
  console.log(`Fastify test server listening on ${baseUrl}`);

  // 3. Track pool and connection metrics
  let maxActivePoolConnections = 0;
  let maxWaitingRequests = 0;

  const poolMonitorInterval = setInterval(() => {
    const total = pool.totalCount;
    const idle = pool.idleCount;
    const active = total - idle;
    const waiting = pool.waitingCount;

    if (active > maxActivePoolConnections) maxActivePoolConnections = active;
    if (waiting > maxWaitingRequests) maxWaitingRequests = waiting;
  }, 20);

  // 4. Run Concurrent Virtual Users
  const metrics: RequestMetric[] = [];
  const startTime = Date.now();
  const endTime = startTime + durationSeconds * 1000;

  async function virtualUserWorker() {
    while (Date.now() < endTime) {
      const reqStart = performance.now();
      try {
        const response = await fetch(`${baseUrl}/documents`, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${token}`,
          },
        });
        const reqEnd = performance.now();
        metrics.push({
          durationMs: reqEnd - reqStart,
          statusCode: response.status,
          isError: response.status >= 400,
        });
        // consume body
        await response.text();
      } catch (err) {
        const reqEnd = performance.now();
        metrics.push({
          durationMs: reqEnd - reqStart,
          statusCode: 0,
          isError: true,
        });
      }
    }
  }

  // Spawn concurrency workers
  await Promise.all(
    Array.from({ length: concurrency }, () => virtualUserWorker()),
  );

  clearInterval(poolMonitorInterval);
  const totalExecutionTimeSec = (Date.now() - startTime) / 1000;

  // 5. Query Plan Inspection (EXPLAIN ANALYZE)
  console.log('\nInspecting PostgreSQL Query Execution Plan...');
  let queryPlanOutput = '';
  await withTenantTransaction(orgId, async (client) => {
    const planResult = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS)
       SELECT id, organisation_id, title, created_at
       FROM knowledge_documents
       ORDER BY created_at DESC`,
    );
    queryPlanOutput = planResult.rows.map((r) => r['QUERY PLAN']).join('\n');
  });

  // 6. Cleanup
  console.log('Cleaning up test tenant data and closing server...');
  await pool.query(`DELETE FROM organisation WHERE id = $1`, [orgId]);
  await app.close();
  await pool.end();

  // 7. Calculate Statistics
  metrics.sort((a, b) => a.durationMs - b.durationMs);

  const totalRequests = metrics.length;
  const errorRequests = metrics.filter((m) => m.isError).length;
  const successRequests = totalRequests - errorRequests;
  const throughputRps = (totalRequests / totalExecutionTimeSec).toFixed(2);
  const errorRatePct = ((errorRequests / (totalRequests || 1)) * 100).toFixed(2);

  const getPercentile = (pct: number) => {
    if (metrics.length === 0) return 0;
    const index = Math.min(
      Math.floor((pct / 100) * metrics.length),
      metrics.length - 1,
    );
    return metrics[index]!.durationMs.toFixed(2);
  };

  const p50 = getPercentile(50);
  const p90 = getPercentile(90);
  const p95 = getPercentile(95);
  const p99 = getPercentile(99);
  const minLatency = (metrics[0]?.durationMs ?? 0).toFixed(2);
  const maxLatency = (metrics[metrics.length - 1]?.durationMs ?? 0).toFixed(2);
  const avgLatency = (
    metrics.reduce((acc, m) => acc + m.durationMs, 0) / (totalRequests || 1)
  ).toFixed(2);

  // 8. Output Report
  console.log(`\n======================================================`);
  console.log(`                BASELINE LOAD TEST RESULTS            `);
  console.log(`======================================================`);
  console.log(`Throughput:`);
  console.log(`  Total Requests:         ${totalRequests}`);
  console.log(`  Successful (200 OK):    ${successRequests}`);
  console.log(`  Throughput:             ${throughputRps} requests/sec`);
  console.log(`  Test Duration:          ${totalExecutionTimeSec.toFixed(2)}s`);
  console.log(`\nLatency:`);
  console.log(`  Min Latency:            ${minLatency} ms`);
  console.log(`  Avg Latency:            ${avgLatency} ms`);
  console.log(`  p50 (Median):           ${p50} ms`);
  console.log(`  p90:                    ${p90} ms`);
  console.log(`  p95:                    ${p95} ms`);
  console.log(`  p99:                    ${p99} ms`);
  console.log(`  Max Latency:            ${maxLatency} ms`);
  console.log(`\nError Rate:`);
  console.log(`  Failed / Error count:   ${errorRequests}`);
  console.log(`  HTTP Error Rate:        ${errorRatePct}%`);
  console.log(`\nDatabase Pool & Concurrency:`);
  console.log(`  Virtual Users (VUs):    ${concurrency}`);
  console.log(`  Max Active DB Conns:    ${maxActivePoolConnections}`);
  console.log(`  Max Pool Waiting Queue: ${maxWaitingRequests}`);
  console.log(`\n------------------------------------------------------`);
  console.log(`Query Execution Plan (EXPLAIN ANALYZE, BUFFERS):`);
  console.log(`------------------------------------------------------`);
  console.log(queryPlanOutput);
  console.log(`======================================================\n`);
}

const concurrency = parseInt(process.env.CONCURRENCY || '20', 10);
const duration = parseInt(process.env.DURATION || '5', 10);

runLoadTest({ concurrency, durationSeconds: duration }).catch((err) => {
  console.error('Load test failed:', err);
  process.exit(1);
});
