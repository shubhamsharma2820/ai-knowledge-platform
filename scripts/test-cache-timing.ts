import { redis } from '../src/db/redis.js';

async function main() {
  const orgId = '653e2e61-745b-452f-a278-0ccc5d790e73';
  const url = `http://localhost:3000/organisations/${orgId}`;
  const cacheKey = `organisation:${orgId}`;

  // 1. Connect to Redis to manage and inspect cache
  if (!redis.isOpen) {
    await redis.connect();
  }

  console.log(`\n======================================================`);
  console.log(`Testing Redis Caching Performance on GET /organisations/:id`);
  console.log(`Target URL: ${url}`);
  console.log(`Cache Key:  ${cacheKey}`);
  console.log(`======================================================\n`);

  // 2. Clear cache key to ensure a pure Cache MISS
  await redis.del(cacheKey);
  console.log(`[Step 0] Cleared key "${cacheKey}" from Redis.`);
  const checkInitial = await redis.get(cacheKey);
  console.log(`[Step 0] Key exists in Redis before Request 1: ${checkInitial !== null ? 'YES' : 'NO'}`);

  // 3. Request 1: Cache MISS (Hits PostgreSQL + Writes to Redis)
  console.log(`\n--> [Request 1] Sending GET request (Expect Cache MISS)...`);
  const t1Start = performance.now();
  const res1 = await fetch(url);
  const t1End = performance.now();
  const data1 = await res1.json();
  const missDuration = t1End - t1Start;

  console.log(`Status Code:    ${res1.status}`);
  console.log(`Response Body:  ${JSON.stringify(data1)}`);
  console.log(`Response Time:  ${missDuration.toFixed(2)} ms (Database Query + Cache Population)`);

  // 4. Verify that Redis now contains the cached data & TTL
  const cachedVal = await redis.get(cacheKey);
  const ttl = await redis.ttl(cacheKey);
  console.log(`\n[Redis Inspection]`);
  console.log(`Cached Value:   ${cachedVal}`);
  console.log(`TTL Remaining:  ${ttl} seconds (configured EX: 60s)`);

  // 5. Request 2: Cache HIT (Hits Redis directly - No DB!)
  console.log(`\n--> [Request 2] Sending GET request (Expect Cache HIT)...`);
  const t2Start = performance.now();
  const res2 = await fetch(url);
  const t2End = performance.now();
  const data2 = await res2.json();
  const hitDuration = t2End - t2Start;

  console.log(`Status Code:    ${res2.status}`);
  console.log(`Response Body:  ${JSON.stringify(data2)}`);
  console.log(`Response Time:  ${hitDuration.toFixed(2)} ms (Served directly from Redis Memory!)`);

  // 6. Run 5 subsequent Cache HIT requests to get a reliable average
  const hitTimes: number[] = [];
  for (let i = 0; i < 5; i++) {
    const tStart = performance.now();
    await fetch(url);
    const tEnd = performance.now();
    hitTimes.push(tEnd - tStart);
  }
  const avgHitTime = hitTimes.reduce((a, b) => a + b, 0) / hitTimes.length;

  // 7. Output Final Comparison
  const speedup = (missDuration / avgHitTime).toFixed(1);

  console.log(`\n======================================================`);
  console.log(`                CACHE PERFORMANCE RESULTS             `);
  console.log(`======================================================`);
  console.log(`1. Cache MISS (PostgreSQL Database):  ${missDuration.toFixed(2)} ms`);
  console.log(`2. First Cache HIT (Redis):           ${hitDuration.toFixed(2)} ms`);
  console.log(`3. Average Cache HIT (5 requests):    ${avgHitTime.toFixed(2)} ms`);
  console.log(`Speedup: Redis is ~${speedup}x faster than PostgreSQL disk query!`);
  console.log(`======================================================\n`);

  await redis.quit();
}

main().catch((err) => {
  console.error('Error during cache test:', err);
  process.exit(1);
});
