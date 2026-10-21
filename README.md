# AI Knowledge Platform — Engineering Journal & Architecture Guide

A production-grade, multi-tenant AI Knowledge Platform backend built with **Node.js**, **TypeScript**, **Fastify**, and **PostgreSQL**.

---

## 📌 Architecture & Design Principles

* **Strict Multi-Tenancy**: Tenant isolation enforced directly in the database engine using PostgreSQL **Row-Level Security (RLS)**.
* **Fail-Closed Security**: Every request must establish authenticated identity and tenant context; missing or invalid contexts fail immediately (`401 Unauthorized`).
* **Privilege Separation**: Database connections switch to a restricted, non-superuser role (`app_user`) with `NOBYPASSRLS` during tenant queries to prevent superuser bypass traps.
* **Connection Pool Safety**: `pg-pool` connections that encounter errors during tenant transactions are evicted (`client.release(err)`) rather than returned tainted.
* **Native ESM & High Performance**: Clean native ECMAScript modules (`"type": "module"`), Node.js native test runner (`node:test`), and `tsx`.

---

## 🚀 Step-by-Step Implementation Log

### Day 1: Foundation, Fastify & Database Infrastructure
1. **Core Runtime**: Node.js v24 + TypeScript with strict compiler options (`noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`).
2. **Fastify Web Server**:
   * Strict JSON schema validation via Ajv (`coerceTypes: false`, `removeAdditional: false`).
   * Centralized error handler (`registerErrorHandler`) mapping custom domain errors (`AppError`) and PostgreSQL codes (e.g. `23505` unique violation $\rightarrow$ `409 Conflict`) to uniform JSON error structures.
3. **Database & Migrations**:
   * PostgreSQL connection pool (`pg.Pool`) configured with SSL support and environment settings.
   * `node-pg-migrate` integrated for version-controlled, up/down SQL schema migrations.
   * Created initial tables: `organisation` table with unique `slug`.

---

### Day 2: Authentication, Password Hashing & RBAC
1. **User Identity & Security**:
   * Migration creating `users` table linked to `organisation(id)`.
   * Security constraints: `role IN ('owner', 'admin', 'member')` with default `'member'`.
   * Case-insensitive email uniqueness via index `users_email_lower_uidx` on `LOWER(TRIM(email))`.
   * Soft-delete (`is_deleted`) and active account enforcement (`is_active`).
2. **Password Hashing with Argon2id**:
   * Industry-standard password hashing using Argon2id (`timeCost: 3`, `memoryCost: 65536` / 64MB, `parallelism: 4`).
   * Sanitization rule: `password` and `password_hash` are never returned in any API response.
3. **JWT Authentication & Lifecycle**:
   * Fastify JWT plugin (`@fastify/jwt`) with short-lived access tokens (15 minutes).
   * Fastify lifecycle hooks:
     * `authenticate`: Validates bearer token signature and expiration.
     * `requireActiveUser`: Checks account validity (`is_active = 1`, `is_deleted = 0`) and decorates request with tenant and role context.
     * `requireRole(...roles)`: RBAC middleware ensuring authorized access.
4. **Endpoints**:
   * `POST /auth/register`: Atomic registration transaction creating both organization and initial owner user.
   * `POST /auth/login`: Timing-safe credential verification returning access token.
   * `GET /auth/me`: Validates user session and tenant identity.

---

### Day 3: Row-Level Security (RLS) & Multi-Tenant Data Isolation

#### 1. Database Row-Level Security Policy
Created table `knowledge_documents` with mandatory tenant reference:
```sql
CREATE TABLE knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisation(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_documents FORCE ROW LEVEL SECURITY;

CREATE POLICY knowledge_documents_tenant_policy ON knowledge_documents
  USING (organisation_id = NULLIF(current_setting('app.organisation_id', true), '')::UUID)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.organisation_id', true), '')::UUID);
```

#### 2. The PostgreSQL Superuser Bypass Trap & The `app_user` Role
* **Problem**: Even with `FORCE ROW LEVEL SECURITY`, PostgreSQL superusers (`rolsuper = true` or `rolbypassrls = true`) bypass RLS policies completely. If an app connects as `postgres`, tests give false confidence.
* **Solution**: Created a dedicated database role `app_user` with `NOSUPERUSER NOBYPASSRLS`. Inside `withTenantTransaction`, every tenant transaction executes:
  ```sql
  SET LOCAL ROLE app_user;
  SELECT set_config('app.organisation_id', $1, true);
  ```

#### 3. Poisoned Connection Pool Prevention
If a query or rollback errors inside a tenant transaction, calling standard `client.release()` returns a broken or session-tainted client back to `pg-pool`. 
We mitigated this by calling `client.release(connectionError)`, forcing `pg-pool` to discard and destroy the connection instead of reusing it.

#### 4. Endpoints
* `GET /documents`: Authenticated route protected by `authenticate` and `requireActiveUser`. Fetches tenant documents using `withTenantTransaction`.

---

## 🧪 Testing Suites & Verification

The project runs **29 automated tests across 6 suites** with 100% pass rate:

```bash
npm test
```

### Breakdown of Test Suites
1. **`test/auth.test.ts`**:
   * Full 6-step authentication lifecycle E2E flow.
   * Valid/invalid registration payloads and rollback integrity.
   * Valid/invalid/expired token lifecycle and inactive user checks.
2. **`test/organisation.test.ts`**:
   * Schema validation, slug uniqueness (409 Conflict), and payload constraints.
3. **`test/documents.test.ts`**:
   * Critical verification: Database connection executes under `app_user` without `BYPASSRLS`.
   * Organization A token $\rightarrow$ returns **only** Org A documents.
   * Organization B token $\rightarrow$ returns **only** Org B documents.
   * Missing token $\rightarrow$ `401 Unauthorized`.
   * Valid token for inactive user $\rightarrow$ `401 Unauthorized`.
4. **`src/modules/documents/documents.rls.test.ts`**:
   * Direct database-level RLS verification ensuring `SELECT id FROM knowledge_documents` (without any explicit SQL `WHERE` clause) strictly isolates tenant rows.

---

## ⚡ Day 3 Baseline Load Test & Performance Metrics

We executed a baseline load test simulating **20 concurrent virtual users (VUs)** over **5 seconds** against `GET /documents`:

```bash
npm run test:load
```

### Baseline Performance Results
* **Total Requests Completed**: `3,727` requests
* **Throughput**: **`743.02` requests / second**
* **Success Rate**: **`100.00%`** (0 HTTP errors, 0 timeouts)
* **Latency Percentiles**:
  * **Min**: `14.53 ms`
  * **Average**: `24.83 ms`
  * **p50 (Median)**: **`23.42 ms`**
  * **p90**: **`29.74 ms`**
  * **p95**: **`32.77 ms`**
  * **p99**: **`44.40 ms`**
  * **Max**: `114.18 ms`
* **Connection Pool Utilization**:
  * Max Active Connections: `10` (max limit of default `pg.Pool`)
  * Max Waiting Queue: `10` requests (VUs queued momentarily during connection checkout)

### Query Execution Plan Analysis (`EXPLAIN ANALYZE, BUFFERS`)
```
Sort  (cost=12.73..12.74 rows=4 width=72) (actual time=0.025..0.026 rows=25 loops=1)
  Sort Key: created_at DESC
  Sort Method: quicksort  Memory: 28kB
  Buffers: shared hit=2
  ->  Bitmap Heap Scan on knowledge_documents  (cost=4.19..12.69 rows=4 width=72) (actual time=0.018..0.019 rows=25 loops=1)
        Recheck Cond: (organisation_id = (NULLIF(current_setting('app.organisation_id'::text, true), ''::text))::uuid)
        Heap Blocks: exact=1
        Buffers: shared hit=2
        ->  Bitmap Index Scan on idx_knowledge_documents_organisation_id  (cost=0.00..4.19 rows=4 width=0) (actual time=0.013..0.013 rows=25 loops=1)
              Index Cond: (organisation_id = (NULLIF(current_setting('app.organisation_id'::text, true), ''::text))::uuid)
              Buffers: shared hit=1
Planning Time: 0.068 ms
Execution Time: 0.041 ms
```

#### Key Query Plan Takeaways:
1. **RLS Transparent Filtering**: PostgreSQL rewrote the query to add the tenant predicate `organisation_id = NULLIF(...)` and scanned through `idx_knowledge_documents_organisation_id`.
2. **Sort Overhead**: Because our current index is only on `(organisation_id)`, PostgreSQL has to fetch the rows and execute an in-memory `quicksort` on `created_at DESC`.
3. **Recommended Optimization (Composite Index)**:
   Adding a composite index on `(organisation_id, created_at DESC)`:
   ```sql
   CREATE INDEX idx_knowledge_documents_org_created_at
   ON knowledge_documents (organisation_id, created_at DESC);
   ```
   This will allow PostgreSQL to perform an **Index Scan** that resolves both the tenant RLS condition and the sort order in one step without any in-memory sort node.

---

### Day 4: Redis Caching, Resilience & High-Concurrency Consistency

#### 1. Redis Infrastructure & Fastify Lifecycles
* **Containerization**: Configured `redis:7-alpine` container running on port `6379`.
* **Client Architecture**: Singleton `createClient` in [`src/db/redis.ts`](src/db/redis.ts) with centralized connection error logging.
* **Fastify Lifecycle Hooks**:
  * `onReady`: Connects to Redis before accepting traffic and verifies connectivity with a ping check.
  * `onClose`: Gracefully disconnects via `redis.quit()`.
* **Health Check**: Added `GET /health/redis` endpoint returning Redis server status.

#### 2. Fail-Open Cache Policy
* For read operations (`GET /organisations/:id`), Redis read and write failures are wrapped in error boundaries (`try/catch`).
* If Redis experiences downtime, network timeouts, or restarts, requests seamlessly fall back to PostgreSQL as the primary source of truth without returning 500 errors to callers.

#### 3. Singleflight Promise Coalescing (Cache Stampede Mitigation)
* **Problem**: When a popular cache key expires or upon a cold start, 100 concurrent requests all miss the cache simultaneously, leading to 100 duplicate database queries (thundering herd / cache stampede).
* **Solution**: In-memory `Map<string, Promise<Organisation | null>>` coalesces all concurrent requests for the same organisation ID into a single shared database lookup promise.
* **Verification Benchmark** ([`scripts/test-concurrent-stampede.ts`](scripts/test-concurrent-stampede.ts)):
  * **100 concurrent cold requests** executed simultaneously.
  * **Database Lookups**: Exactly **1** PostgreSQL lookup.
  * **Success Rate**: **100%** (100 / 100 requests).
  * **Subsequent Request Latency**: **`1.17 ms`** (served directly from Redis cache).

#### 4. Cache Versioning & Stale Repopulation Prevention
* **The Race Condition**: A slow in-flight read starting with old data (`Acme`) could finish after a concurrent database update to `Acme Technologies` and overwrite the freshly invalidated Redis cache with stale data.
* **Database Migration**: Added column `cache_version BIGINT NOT NULL DEFAULT 1` to `organisation` table ([`migrations/1792519203611_add-cache-version-to-organisation.sql`](migrations/1792519203611_add-cache-version-to-organisation.sql)).
* **Atomic Version Guard**:
  When updating an organisation:
  ```sql
  UPDATE organisation
  SET
    name = $2,
    cache_version = cache_version + 1,
    updated_at = NOW()
  WHERE id = $1
  RETURNING id, name, slug, cache_version;
  ```
* In `getOrganisationById`, Redis writes execute an atomic Lua script that compares `organisation:{id}:version`. If a newer version is already recorded in Redis, the stale write is discarded.

#### 5. Post-Commit Cache Invalidation
* **Transaction Rollback Safety**: Cache invalidation must never execute before or during an uncommitted database transaction.
* Database mutations execute within an explicit PostgreSQL transaction block (`BEGIN` ... `COMMIT` / `ROLLBACK`).
* Strictly **after** the transaction successfully commits, cache invalidation is executed:
  ```typescript
  try {
    if (redis.isOpen) {
      await redis.set(`organisation:${id}:version`, String(organisation.cache_version), {
        EX: 300,
      });
    }
    await redis.del(`organisation:${id}`);
  } catch (error) {
    console.error('Organisation cache invalidation failed:', error);
  }
  ```
* If the database transaction fails or is aborted, Redis is never modified, completely preventing dirty cache writes.

#### 6. Endpoints
* `PATCH /organisations/:id` & `PUT /organisations/:id`: Updates organisation name, increments `cache_version`, and triggers post-commit cache invalidation.

---

## 🧪 Testing Suites & Verification

The project runs **32 automated tests across 7 suites** with a 100% pass rate:

```bash
npm test
```

### Breakdown of Test Suites
1. **`test/auth.test.ts`**:
   * Full 6-step authentication lifecycle E2E flow.
   * Valid/invalid registration payloads and rollback integrity.
   * Valid/invalid/expired token lifecycle and inactive user checks.
2. **`test/organisation.test.ts`**:
   * Schema validation, slug uniqueness (409 Conflict), and payload constraints.
3. **`test/documents.test.ts`**:
   * Critical verification: Database connection executes under `app_user` without `BYPASSRLS`.
   * Organization A token $\rightarrow$ returns **only** Org A documents.
   * Organization B token $\rightarrow$ returns **only** Org B documents.
   * Missing token $\rightarrow$ `401 Unauthorized`.
   * Valid token for inactive user $\rightarrow$ `401 Unauthorized`.
4. **`src/modules/documents/documents.rls.test.ts`**:
   * Direct database-level RLS verification ensuring `SELECT id FROM knowledge_documents` strictly isolates tenant rows.
5. **`test/cache-race.test.ts`**:
   * `PATCH /organisations/:id` updates name and increments `cache_version`.
   * Simulates slow in-flight read and verifies that version-guarded writes reject stale data repopulation.
   * Verifies post-commit invalidation: cache key is deleted after transaction commit.

---

## ⚡ Performance Metrics Summary

* **Cache Miss Latency**: `~65 ms` (PostgreSQL query + network round-trip).
* **Cache Hit Latency**: **`~1.17 ms - 3.68 ms`** (**~17.8x - 55x speedup**).
* **Stampede Test**: 100 concurrent cold hits coalesced into 1 database query.
* **Baseline Throughput**: `743.02 req/sec` with median latency `23.42 ms`.

---

## 🔮 Next Steps: Day 5 (Rate Limiting & Tenant Document Caching)
* **Tenant Document Caching**: Cache tenant documents with tenant-scoped keys (e.g. `tenant:{orgId}:documents`).
* **Rate Limiting**: Sliding-window or token-bucket rate limiter per tenant / user via Redis.
* **Distributed Locking / Circuit Breaker**: Circuit breaker and bulkheads for downstream failure isolation.