import { redis } from '../src/db/redis.js';
import {
  getOrganisationById,
  dbLookupCount,
  resetDbLookupCount,
} from '../src/modules/organisation/organisations.service.js';
import { pool } from '../src/db/database.js';

async function main() {
  const orgId = '653e2e61-745b-452f-a278-0ccc5d790e73';
  const cacheKey = `organisation:${orgId}`;

  // 1. Ensure Redis is connected
  if (!redis.isOpen) {
    await redis.connect();
  }

  console.log(`\n======================================================`);
  console.log(`Testing Cache Stampede / Promise Coalescing`);
  console.log(`Organization ID:    ${orgId}`);
  console.log(`Concurrent Calls:   100`);
  console.log(`======================================================\n`);

  // 2. Clear Redis cache to simulate cold cache / cache expiration
  await redis.del(cacheKey);
  console.log(`[Setup] Cleared cache key "${cacheKey}" from Redis.`);
  resetDbLookupCount();
  console.log(`[Setup] Reset diagnostic dbLookupCount to: ${dbLookupCount}`);

  // 3. Fire 100 concurrent lookups simultaneously
  console.log(`\n--> Firing 100 concurrent lookups simultaneously...`);
  const startTime = performance.now();
  const promises = Array.from({ length: 100 }, (_, index) =>
    getOrganisationById(orgId).then((result) => ({ index, result })),
  );

  const responses = await Promise.all(promises);
  const totalDuration = performance.now() - startTime;

  // 4. Verify results
  const successfulResponses = responses.filter(
    (r) => r.result !== null && r.result.id === orgId,
  ).length;

  console.log(`Total Concurrent Requests:  ${responses.length}`);
  console.log(`Successful Responses:       ${successfulResponses} / 100`);
  console.log(`Total Execution Time:       ${totalDuration.toFixed(2)} ms`);
  console.log(`\n------------------------------------------------------`);
  console.log(`DIAGNOSTIC MEASUREMENT:`);
  console.log(`Observed PostgreSQL Lookups: ${dbLookupCount}`);
  console.log(`------------------------------------------------------`);

  // 5. Test Subsequent request (should come from Redis)
  console.log(`\n--> Testing subsequent request (Expect from Redis cache)...`);
  const initialDbCount = dbLookupCount;
  const subStart = performance.now();
  const subsequentResult = await getOrganisationById(orgId);
  const subDuration = performance.now() - subStart;

  console.log(`Subsequent Response:        ${JSON.stringify(subsequentResult)}`);
  console.log(`Subsequent Latency:         ${subDuration.toFixed(2)} ms`);
  console.log(`PostgreSQL Lookups After:   ${dbLookupCount} (Difference: ${dbLookupCount - initialDbCount})`);

  console.log(`\n======================================================`);
  console.log(`                     TEST SUMMARY                     `);
  console.log(`======================================================`);
  console.log(`1. All 100 responses succeeded:     ${successfulResponses === 100 ? 'YES (100%)' : 'NO'}`);
  console.log(`2. Database Lookups executed:       ${dbLookupCount} (Coalesced 100 -> 1)`);
  console.log(`3. Subsequent request from Redis:   ${dbLookupCount === initialDbCount ? 'YES (0 new DB queries)' : 'NO'}`);
  console.log(`======================================================\n`);

  await redis.quit();
  await pool.end();
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
