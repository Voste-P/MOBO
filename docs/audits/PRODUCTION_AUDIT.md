# MOBO Production-Readiness Audit

**Generated:** 2025-01-XX  
**Scope:** Express backend, Prisma ORM / PostgreSQL, 5 Next.js frontends, shared UI layer  
**Focus areas:** Security, performance, data integrity, error handling, scalability

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 3     |
| HIGH     | 8     |
| MEDIUM   | 11    |
| LOW      | 6     |
| **Total**| **28**|

---

## CRITICAL

### C-1 · `orderListSelect` transfers multi-MB base64 blobs on every list query

**File:** `backend/utils/querySelect.ts` L115-160  
**Used in:** `backend/controllers/ordersController.ts` L252, `backend/controllers/opsController.ts` L478, `backend/controllers/brandController.ts` L189

**What's wrong:**  
`orderListSelect` includes every screenshot column (`screenshotOrder`, `screenshotPayment`, `screenshotRating`, `screenshotReview`, `screenshotReturnWindow`). Each column can hold a base64 data-URL of 100 KB–5 MB. A 50-row list page can therefore return **50–250 MB** of JSON. This causes:
- Node.js process OOM or GC thrashing under load  
- Extremely slow responses over mobile networks  
- Database transfer bottleneck (full TOAST column reads)

The `orderListSelectLite` + `getProofFlags()` pattern already exists but is **only used in `adminController`**. The three controllers above still use the heavy select.

**Fix:**  
Replace `orderListSelect` with `orderListSelectLite` in all list endpoints and merge `getProofFlags()` results. Keep `orderListSelect` only for *single-order detail* endpoints.

---

### C-2 · Admin endpoints default to `limit: 10 000` — unbounded result sets

**File:** `backend/controllers/adminController.ts` L114, L152, L297  
**Also:** `backend/controllers/inviteController.ts` L124, `backend/controllers/ticketsController.ts` L158

**What's wrong:**  
`parsePagination(req.query, { limit: 10000, maxLimit: 10000 })` allows (and defaults to) fetching up to 10 000 rows in one request. Combined with C-1 (heavy selects), a single admin page load can attempt to serialize gigabytes. Even with `orderListSelectLite`, 10 000 user/order rows is an expensive query that can stall the connection pool.

**Fix:**  
Lower default limit to 50, maxLimit to 500 (matching the existing `parsePagination` default cap). Admin frontends already send `page`/`limit` params; server should enforce the ceiling.

```ts
// Before
parsePagination(req.query, { limit: 10000, maxLimit: 10000 });
// After
parsePagination(req.query, { limit: 50, maxLimit: 500 });
```

---

### C-3 · In-memory rate limiter & CSRF state store break under multi-instance deployment

**File:** `backend/routes/mediaRoutes.ts` L17 (`ipHits` Map)  
**File:** `backend/routes/googleRoutes.ts` L50 (`pendingStates` Map)

**What's wrong:**  
Both data structures are per-process `Map` objects. In a multi-instance deployment (Render auto-scale, k8s replicas, etc.):
- **Rate limiter:** Each instance tracks its own counts, so an attacker gets `N × 120 req/min` where N is the replica count.
- **OAuth CSRF state:** The `/auth` request creates State on instance A, but the `/callback` may land on instance B that has no knowledge of the state — every OAuth flow would fail ~50 % of the time.

**Fix — rate limiter:** Use the existing `express-rate-limit` + `rate-limit-redis` (or Render's built-in load balancer rate limits). Alternatively, replace the custom Map with a Redis-backed store.

**Fix — CSRF state:** Store the CSRF state in the database (`OAuthState` table with TTL) or in Redis with a 10-minute expiry. For single-instance deployments this is acceptable, but document the limitation prominently.

---

## HIGH

### H-1 · Deprecated `requireAuthOrToken` still used in production route

**File:** `backend/routes/ordersRoutes.ts` L39  
**Definition:** `backend/middleware/auth.ts` L216

**What's wrong:**  
`requireAuthOrToken` is explicitly marked `@deprecated` in its JSDoc. It allows order proof access via a `?token=` query param (a simple string comparison), bypassing JWT auth. If the static token value is weak or leaked, anyone can access proof screenshots.

**Fix:**  
Replace with `requireAuth` and have the frontend pass the JWT `Authorization` header instead. If public proof links are needed, implement time-limited signed URLs.

---

### H-2 · Security middleware detects but does NOT block SQL/NoSQL injection or XSS

**File:** `backend/middleware/security.ts` L107-142

**What's wrong:**  
Phase 2 of `securityAuditMiddleware` only **logs** patterns matching SQL injection (`UNION SELECT`, `; DROP`, `$gt`, `$ne`), XSS (`<script>`, `javascript:`, `onerror=`), etc. Since the application uses Prisma (parameterized queries), SQL injection risk from these patterns is low, but XSS payloads stored in user-controlled fields (name, description, ticket body) could be served to other users.

**Fix:**  
For high-confidence XSS patterns (`<script`, `javascript:`, `onerror=`, `onload=`), **sanitise the value** (strip tags) or reject the request outright, not just log. This is defense-in-depth given React's built-in escaping.

---

### H-3 · `oauthStates` / `pendingStates` Map grows without bound on high traffic

**File:** `backend/routes/googleRoutes.ts` L50-57

**What's wrong:**  
`cleanupStaleStates()` only runs lazily when a new `/auth` request arrives. Under sustained attack (many `/auth` requests, never completing callback), the Map grows monotonically until the process restarts. There is no periodic cleanup timer (unlike `mediaRoutes` which has `setInterval`).

**Fix:**  
Add a periodic cleanup using `setInterval(...).unref()` (same pattern as `mediaRoutes`), or cap the Map size (e.g., reject new auth requests when > 10 000 pending states).

---

### H-4 · Base64 proof images stored directly in PostgreSQL — scaling concern

**File:** `backend/controllers/ordersController.ts` L572-582, L640-650

**What's wrong:**  
Proof screenshots are stored as base64 text in `screenshotOrder`, `screenshotPayment`, etc. columns. Each image can be up to **~20 MB** (per `REQUEST_BODY_LIMIT`). This means:
- Each `Order` row in TOAST storage can be 60+ MB (5 screenshots × 12 MB avg)
- Database backups grow extremely large
- `pg_dump` and point-in-time recovery slowed dramatically
- Vacuum, replication, and connection pool bandwidth all affected

**Fix (medium-term):**  
Migrate screenshot storage to an object store (S3 / R2 / GCS): store a URL reference in the DB column, upload the blob via a presigned URL. This also enables CDN caching for proof display.

---

### H-5 · `opsController.getOrders` uses heavy `orderListSelect` for all ops queries

**File:** `backend/controllers/opsController.ts` L478

**What's wrong:**  
The ops getOrders endpoint fetches orders with the full `orderListSelect` (includes all base64 screenshot columns). Ops users typically view order **lists** with status/flags, not full screenshots. This causes extreme over-fetching, especially when agencies have hundreds of orders.

**Fix:**  
Switch to `orderListSelectLite` + `getProofFlags()` (same pattern already used in `adminController.getProducts`).

---

### H-6 · `ordersController.getOrders` returns screenshots in list response

**File:** `backend/controllers/ordersController.ts` L252

**What's wrong:**  
Buyer order list endpoint uses `orderListSelect` which fetches all screenshot blobs. Even a buyer with 10 orders could receive 50+ MB of JSON.

**Fix:**  
Use `orderListSelectLite` for the list endpoint. Serve individual screenshots via a dedicated `/orders/:id/proof/:type` endpoint (which already exists).

---

### H-7 · No refresh token rotation / revocation mechanism

**File:** `backend/controllers/authController.ts` L443-478

**What's wrong:**  
The `refresh` endpoint issues a new access + refresh token pair but does not invalidate the old refresh token. This means:
- A stolen refresh token can be used indefinitely until it expires (30 days default)
- There is no way to force-logout a user (no token blacklist)
- Refresh token replay attacks are possible

**Fix:**  
Implement refresh token rotation: store a token family identifier in the DB, and on each refresh call, invalidate the old token. If a revoked token is presented, invalidate the entire family (signals compromise). At minimum, add a `tokenVersion` column on `User` and include it in the JWT claims — incrementing it force-expires all existing tokens.

---

### H-8 · Settlement payment uses non-unique idempotency keys for unsettlement

**File:** `backend/controllers/opsController.ts` L1855-1895 (unsettleOrderPayment)

**What's wrong:**  
Unsettlement idempotency keys use patterns like `order-unsettle-credit-brand-${order.mongoId}`. If an order is settled, unsettled, settled again, and then unsettled again, the second unsettlement will hit the idempotency guard and silently succeed without actually moving funds (the `existingTx` short-circuit in `applyWalletCredit`).

**Fix:**  
Include a monotonically increasing version or timestamp in the idempotency key:
```ts
`order-unsettle-credit-brand-${order.mongoId}-v${Date.now()}`
```
Or better: include the wallet `version` field in the key so each cycle generates a unique key.

---

## MEDIUM

### M-1 · `getProofFlags` uses `$queryRawUnsafe` with array parameter

**File:** `backend/utils/querySelect.ts` L214-223

**What's wrong:**  
`$queryRawUnsafe` does not parameterise by default like `$queryRaw` (tagged template). However, in this specific usage the `$1::uuid[]` syntax is passed as a parameter (not string-interpolated), so the risk is low. Still, naming and approach are confusing and should be modernized.

**Fix:**  
Switch to `$queryRaw` (tagged template literal) which provides compile-time safety:
```ts
await prisma.$queryRaw`
  SELECT id, ... FROM orders WHERE id = ANY(${orderIds}::uuid[])
`;
```

---

### M-2 · `getPendingUsers` / `getVerifiedUsers` don't return pagination totals

**File:** `backend/controllers/opsController.ts` L505-543, L556-600

**What's wrong:**  
These endpoints return a flat array with no `total` count. The frontend can't show "Page X of Y" or know if there are more results. Default limit is 200 which will fetch the full table for most mediators, but larger agencies will hit silent truncation.

**Fix:**  
Use `parsePagination` + `paginatedResponse` (same pattern as `getLedger`) and add a parallel `count()` query.

---

### M-3 · No database index on `orders.managerName` (mediatorCode foreign key)

**File:** `backend/controllers/opsController.ts` — multiple endpoints filter by `order.managerName`

**What's wrong:**  
Most ops queries filter orders by `managerName` (mediator code string). If this column is not indexed, every scoped query performs a sequential scan. With thousands of orders this becomes a critical performance bottleneck.

**Fix:**  
Add a Prisma migration:
```prisma
@@index([managerName])
```
Also consider indexing `agencyName`, `userId`, and `brandUserId` on the orders table if not already present.

---

### M-4 · AI verification only runs in production — test and staging gaps

**File:** `backend/controllers/ordersController.ts` L901-905

**What's wrong:**  
```ts
if (env.NODE_ENV === 'test') {
  // Test runs should not rely on external AI services.
}
```
AI proof verification is skipped entirely in non-production environments. This means staging environments can't validate the AI pipeline, and integration tests can't verify the verification flow with mocked AI.

**Fix:**  
Introduce an `AI_ENABLED` flag (already in env schema) or mock the AI service in test/staging rather than skipping the code path entirely.

---

### M-5 · `brandController.getOrders` fetches screenshots for brand order lists

**File:** `backend/controllers/brandController.ts` L189

**What's wrong:**  
Uses `orderListSelect` (heavy) for brand order lists. Brand portal has `toUiOrderForBrand` which does send screenshots (intentionally, for brand proof verification), but the list view (`toUiOrderSummaryForBrand`) doesn't use screenshots. List and detail should be separated.

**Fix:**  
Use `orderListSelectLite` for the list endpoint; use `orderListSelect` only on the single-order detail endpoint.

---

### M-6 · Missing `Content-Security-Policy` header

**File:** `backend/app.ts` (Helmet configuration)

**What's wrong:**  
Helmet is configured but the CSP directive defaults may not cover all attack vectors. A strict CSP prevents XSS even if sanitization is bypassed. The API returns JSON so CSP is less relevant for the API itself, but if any HTML is ever served (health pages, OAuth callback), a missing CSP allows inline script execution.

**Fix:**  
Add explicit CSP for the OAuth callback HTML response in `googleRoutes.ts` (which generates inline HTML with `postMessage`). Use `helmet.contentSecurityPolicy()` with a strict policy for any HTML-serving routes.

---

### M-7 · Race condition in campaign slot release on proof rejection

**File:** `backend/controllers/opsController.ts` L1347-1353

**What's wrong:**  
When an order proof is rejected and the slot is released:
```sql
UPDATE "campaigns" SET "used_slots" = GREATEST("used_slots" - 1, 0) WHERE id = $1
```
This runs outside the main order update transaction, so if the rejection fails after the slot release, the slot count becomes incorrect (decremented without a corresponding order status change).

**Fix:**  
Move the slot release into the same transaction as the order update, or use a compensating action pattern.

---

### M-8 · Wallet `version` field is incremented but never checked (no OCC on reads)

**File:** `backend/services/walletService.ts` L97, L190

**What's wrong:**  
The wallet `version` field is incremented on every credit/debit, but no operation ever reads and checks the version as a condition (optimistic concurrency). The `updateMany` WHERE clause checks `availablePaise` limits but not `version`. The version field serves no purpose in its current form.

**Fix:**  
Either remove version to avoid confusion, or implement proper OCC:
```ts
const updated = await tx.wallet.updateMany({
  where: { ownerUserId, version: currentVersion, ... },
  data: { version: { increment: 1 }, ... },
});
if (updated.count === 0) throw new AppError(409, 'CONCURRENT_MODIFICATION', '...');
```

---

### M-9 · Admin `deleteDeal` / `deleteUser` / `deleteWallet` lack confirmation token

**File:** `backend/controllers/adminController.ts` (destructive endpoints)

**What's wrong:**  
Route-level middleware checks for `X-Confirm-Delete` header (in `adminRoutes.ts`), but this is a static string check — it prevents accidental clicks but not CSRF or replay. The confirmation value is not tied to the specific entity being deleted.

**Fix:**  
Bind the confirmation token to the specific entity ID (e.g., `X-Confirm-Delete: delete-{entityId}`) and validate server-side. This prevents a single intercepted header from being replayed for different entities.

---

### M-10 · SSE realtime hub: EventEmitter with 500 max listeners doesn't scale horizontally

**File:** `backend/services/realtimeHub.ts`

**What's wrong:**  
`EventEmitter` with `maxListeners = 500` is single-process. With multiple server instances behind a load balancer, SSE events emitted on instance A won't reach clients connected to instance B.

**Fix:**  
For multi-instance deployment, use Redis Pub/Sub as a cross-process event bus. Each instance subscribes to Redis and forwards events to its local SSE clients.

---

### M-11 · `opsController` re-queries orders 3 times per verification flow

**File:** `backend/controllers/opsController.ts` L956-965

**What's wrong:**  
In `verifyOrderClaim`, the order is:
1. Fetched initially (L917)
2. Re-fetched after update (L951: `const updatedOrder = await db().order.findFirst(...)`)
3. Re-fetched again for the response (L1010: `const refreshed = await db().order.findFirst(...)`)

That's 3 full order reads (with `include: { items: true }`) for one verification call.

**Fix:**  
Return the updated order from the `db().order.update()` call using `include: { items: true }`, then pass it to both `finalizeApprovalIfReady` and the response. Should cut DB round-trips by ~40%.

---

## LOW

### L-1 · No request logging for SSE connections

**File:** `backend/routes/realtimeRoutes.ts`

**What's wrong:**  
SSE routes are explicitly excluded from request timeout middleware, body parsers, and CORS compression — but they're also excluded from access logging. When an SSE connection is established or dropped, there's no access log entry correlating the user to the connection lifecycle.

**Fix:**  
Add a lightweight access log entry on SSE connection open and close (using `req.on('close', ...)` callback).

---

### L-2 · `sheetsRoutes` uses manual input validation instead of Zod

**File:** `backend/routes/sheetsRoutes.ts`

**What's wrong:**  
Unlike other routes that use Zod schemas, the Sheets export route performs manual `String(req.body.xxx)` validation. This is inconsistent and more error-prone.

**Fix:**  
Add a Zod schema for the Sheets export request body.

---

### L-3 · Hard-coded magic numbers scattered through controllers

**Files:** Multiple controllers

**What's wrong:**  
Values like `MAX_FAILED_ATTEMPTS = 7`, `LOCKOUT_DURATION_MS = 15 * 60 * 1000`, velocity limits `10/hour, 30/day`, and default pagination limits appear as inline constants. Changing these requires code changes and redeployment.

**Fix:**  
Move to environment variables (for deployment-time tuning) or a dedicated config object. Some (like `AI_PROOF_CONFIDENCE_THRESHOLD`) are already env-driven; extend this pattern to auth lockout, velocity limits, and pagination defaults.

---

### L-4 · `resolvedExternalOrderId` uniqueness check is per-user, not global

**File:** `backend/controllers/ordersController.ts` L430-445

**What's wrong:**  
Duplicate order detection checks `externalOrderId` scoped to the same buyer (`userId`). Two different buyers can create orders with the same external order ID. Depending on business rules, this may or may not be intentional — but it could allow fraud (two buyers claiming the same Amazon order).

**Fix:**  
If external order IDs should be globally unique, add a unique constraint on `(externalOrderId)` with a partial index (`WHERE externalOrderId IS NOT NULL AND deletedAt IS NULL`). If per-buyer uniqueness is correct, document this decision.

---

### L-5 · Missing graceful error for JWT with future `iat` (clock skew)

**File:** `backend/middleware/auth.ts`

**What's wrong:**  
JWT verification uses default `jsonwebtoken` options which reject tokens with `iat` in the future. In distributed systems with clock skew between servers, this can cause intermittent 401 errors.

**Fix:**  
Add a small `clockTolerance` (e.g., 30 seconds) to `jwt.verify()` options.

---

### L-6 · `setInterval` cleanup in mediaRoutes could fire after shutdown

**File:** `backend/routes/mediaRoutes.ts` L32

**What's wrong:**  
The `.unref()` call prevents the timer from keeping the process alive, which is correct. However, during graceful shutdown, the timer may fire and attempt to iterate the Map while requests are being drained.

**Fix:**  
Store the interval handle and clear it in the graceful shutdown handler (`process.on('SIGTERM', ...)`).

---

## Already Well-Implemented (no action needed)

These areas were reviewed and found to be production-quality:

| Area | Details |
|------|---------|
| **Auth zero-trust** | Roles always re-fetched from DB, never trusted from JWT claims |
| **Upstream suspension cascade** | Buyer → Mediator → Agency chain is enforced before every operation |
| **Wallet atomicity** | `updateMany` with balance-floor / balance-ceiling in WHERE clause prevents double-spend and overflow |
| **Idempotency keys** | All wallet mutations use idempotency keys to prevent duplicate transactions |
| **Order state machine** | `transitionOrderWorkflow` uses optimistic-concurrency (conditional `updateMany`) to prevent invalid transitions |
| **Frozen order enforcement** | Every mutation endpoint checks `order.frozen` before proceeding |
| **Graceful shutdown** | In-flight request draining, forced kill timer, keepAliveTimeout > LB idle |
| **Logging** | CrowdStrike 4-type logging, sensitive data redaction, log explosion prevention |
| **Error handling** | Comprehensive global error handler covering Prisma, Zod, JWT, network errors |
| **Anti-fraud velocity limits** | 10/hour, 30/day per buyer for order creation |
| **Campaign slot atomicity** | Raw SQL `UPDATE ... WHERE used_slots < total_slots RETURNING id` prevents overselling |
| **SSRF protection** | Image proxy blocks private/link-local/metadata IPs |
| **CORS fail-closed** | Unknown origins are rejected, not silently allowed |
| **Password hashing** | bcrypt with SHA-256 pre-hash for >72-byte passwords |
| **Account lockout** | 7 failed attempts → 15-minute lockout with security incident logging |
| **Env validation** | Zod schema enforces production secrets ≥32 chars, DATABASE_URL required, CORS_ORIGINS required |
