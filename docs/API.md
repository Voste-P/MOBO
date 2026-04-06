# API Surface (UI Contract)

> **121 endpoints** across 14 route files. Last updated: April 2026.

All endpoints are rooted at `/api`.

## Conventions

- **Auth**: send `Authorization: Bearer <accessToken>`.
- **Content type**: JSON requests should use `Content-Type: application/json`.
- **Money**: all wallet balances and ledger amounts are stored in **paise** (integer).
- **Roles**: `shopper` (buyer), `mediator`, `agency`, `brand`, `ops`, `admin`.
  - Backend uses `shopper` for buyers; UI may display as `user`.
  - Most authorization checks combine **role gates** + **ownership scoping**.
- **Soft-delete rule**: every destructive operation sets `deletedAt` — no hard deletes in production.

## Portal Integration (Next.js)

All 5 portals proxy `/api/:path*` → backend via `next.config.js` rewrites.

| Env var                        | Where                   | Purpose                        |
| ------------------------------ | ----------------------- | ------------------------------ |
| `NEXT_PUBLIC_API_PROXY_TARGET` | Vercel project settings | Backend URL for proxy rewrites |
| `NEXT_PUBLIC_API_URL`          | Optional override       | Direct API base URL            |

**⚠️ Critical**: if `NEXT_PUBLIC_API_PROXY_TARGET` is not set on Vercel, API calls will fail. Build logs will warn you.

Client base URL resolution (`shared/utils/apiBaseUrl.ts`):

1. `globalThis.__MOBO_API_URL__` 2. `VITE_API_URL` 3. `NEXT_PUBLIC_API_URL` 4. Same-origin `/api` 5. `localhost:8080` 6. `/api`

## Error Format

```json
{ "error": { "code": "SOME_CODE", "message": "Human readable", "details": [] } }
```

Statuses: `400` validation, `401` unauthenticated, `403` forbidden, `404` not found, `409` conflict, `429` rate limit, `500` server.

---

## Health (4 endpoints)

| Method | Path                | Auth | Description                                       |
| ------ | ------------------- | ---- | ------------------------------------------------- |
| GET    | `/api/health/live`  | No   | Liveness probe (always 200)                       |
| GET    | `/api/health/ready` | No   | Readiness probe (DB connected)                    |
| GET    | `/api/health`       | No   | Full health check — 200 if PG connected, else 503 |
| GET    | `/api/health/e2e`   | No   | E2E test readiness check                          |

## Realtime (2 endpoints)

| Method | Path                   | Auth | Description          |
| ------ | ---------------------- | ---- | -------------------- |
| GET    | `/api/realtime/health` | No   | SSE subsystem health |
| GET    | `/api/realtime/stream` | Yes  | SSE event stream     |

Events: `ready`, `ping`, `deals.changed`, `users.changed`, `orders.changed`, `wallets.changed`, `tickets.changed`, `notifications.changed`. See `docs/REALTIME.md`.

## Auth — `/api/auth` (7 endpoints)

| Method | Path                       | Auth | Description                                          |
| ------ | -------------------------- | ---- | ---------------------------------------------------- |
| POST   | `/api/auth/register`       | No   | Buyer registration (invite-based via `mediatorCode`) |
| POST   | `/api/auth/login`          | No   | Login → `{ user, tokens }`                           |
| POST   | `/api/auth/refresh`        | No   | Refresh access token                                 |
| GET    | `/api/auth/me`             | Yes  | Current user profile                                 |
| POST   | `/api/auth/register-ops`   | No   | Agency/mediator registration (invite-based)          |
| POST   | `/api/auth/register-brand` | No   | Brand registration (invite-based)                    |
| PATCH  | `/api/auth/profile`        | Yes  | Update profile (RBAC/ownership enforced)             |

**AuthResponse**: `{ user: { id, role, name, ... }, tokens: { accessToken, refreshToken } }`

## Admin — `/api/admin` (17 endpoints) — role: `admin`

| Method | Path                           | Description                                                                 |
| ------ | ------------------------------ | --------------------------------------------------------------------------- |
| GET    | `/api/admin/invites`           | List all invites                                                            |
| POST   | `/api/admin/invites`           | Create invite                                                               |
| POST   | `/api/admin/invites/revoke`    | Revoke invite                                                               |
| DELETE | `/api/admin/invites/:code`     | Delete invite (soft)                                                        |
| GET    | `/api/admin/config`            | System config                                                               |
| PATCH  | `/api/admin/config`            | Update system config                                                        |
| GET    | `/api/admin/users`             | List users (filter: `role`)                                                 |
| GET    | `/api/admin/financials`        | Platform financials                                                         |
| GET    | `/api/admin/stats`             | Dashboard stats                                                             |
| GET    | `/api/admin/growth`            | Growth metrics                                                              |
| GET    | `/api/admin/products`          | All products/deals                                                          |
| PATCH  | `/api/admin/users/status`      | Suspend/activate user                                                       |
| DELETE | `/api/admin/products/:dealId`  | Soft-delete deal                                                            |
| DELETE | `/api/admin/users/:userId`     | Soft-delete user                                                            |
| DELETE | `/api/admin/wallets/:userId`   | Soft-delete wallet                                                          |
| POST   | `/api/admin/orders/reactivate` | Reactivate order                                                            |
| GET    | `/api/admin/audit-logs`        | Audit logs (filters: `action`, `entityType`, `limit`, `page`, `from`, `to`) |

## Ops — `/api/ops` (29 endpoints) — roles: `agency|mediator|ops|admin`

### Invites

| Method | Path                              | Description              |
| ------ | --------------------------------- | ------------------------ |
| POST   | `/api/ops/invites/generate`       | Generate mediator invite |
| POST   | `/api/ops/invites/generate-buyer` | Generate buyer invite    |

### Brand Connection

| Method | Path                      | Description                            |
| ------ | ------------------------- | -------------------------------------- |
| POST   | `/api/ops/brands/connect` | Request brand connection (agency-only) |

### Network & Operations

| Method | Path                      | Description             |
| ------ | ------------------------- | ----------------------- |
| GET    | `/api/ops/mediators`      | List mediators (scoped) |
| GET    | `/api/ops/campaigns`      | List campaigns (scoped) |
| GET    | `/api/ops/deals`          | List deals (scoped)     |
| GET    | `/api/ops/orders`         | List orders (scoped)    |
| GET    | `/api/ops/users/pending`  | Pending users           |
| GET    | `/api/ops/users/verified` | Verified users          |
| GET    | `/api/ops/ledger`         | Transaction ledger      |

### Approvals & Workflow

| Method | Path                                 | Description               |
| ------ | ------------------------------------ | ------------------------- |
| POST   | `/api/ops/mediators/approve`         | Approve mediator          |
| POST   | `/api/ops/mediators/reject`          | Reject mediator           |
| POST   | `/api/ops/users/approve`             | Approve user              |
| POST   | `/api/ops/users/reject`              | Reject user               |
| POST   | `/api/ops/verify`                    | Verify order claim        |
| POST   | `/api/ops/orders/verify-requirement` | Verify single requirement |
| POST   | `/api/ops/orders/verify-all`         | Verify all proof steps    |
| POST   | `/api/ops/orders/reject-proof`       | Reject proof              |
| POST   | `/api/ops/orders/request-proof`      | Request missing proof     |
| POST   | `/api/ops/orders/settle`             | Settle order payment      |
| POST   | `/api/ops/orders/unsettle`           | Reverse settlement        |

### Campaigns & Deals

| Method | Path                                    | Description                |
| ------ | --------------------------------------- | -------------------------- |
| POST   | `/api/ops/campaigns`                    | Create campaign            |
| POST   | `/api/ops/campaigns/copy`               | Copy campaign              |
| POST   | `/api/ops/campaigns/decline`            | Decline offer              |
| PATCH  | `/api/ops/campaigns/:campaignId/status` | Update campaign status     |
| DELETE | `/api/ops/campaigns/:campaignId`        | Soft-delete campaign       |
| POST   | `/api/ops/campaigns/assign`             | Assign slots (locks terms) |
| POST   | `/api/ops/deals/publish`                | Publish deal               |

### Payouts

| Method | Path                         | Description     |
| ------ | ---------------------------- | --------------- |
| POST   | `/api/ops/payouts`           | Payout mediator |
| DELETE | `/api/ops/payouts/:payoutId` | Cancel payout   |

## Brand — `/api/brand` (11 endpoints) — roles: `brand|admin|ops`

| Method | Path                               | Description                                |
| ------ | ---------------------------------- | ------------------------------------------ |
| GET    | `/api/brand/agencies`              | Connected agencies                         |
| GET    | `/api/brand/campaigns`             | Brand campaigns                            |
| GET    | `/api/brand/orders`                | Brand orders                               |
| GET    | `/api/brand/transactions`          | Brand transactions                         |
| POST   | `/api/brand/payout`                | Pay out to agency                          |
| POST   | `/api/brand/requests/resolve`      | Approve/reject agency connection           |
| POST   | `/api/brand/agencies/remove`       | Remove agency connection                   |
| POST   | `/api/brand/campaigns`             | Create campaign                            |
| POST   | `/api/brand/campaigns/copy`        | Copy campaign                              |
| PATCH  | `/api/brand/campaigns/:campaignId` | Update campaign (locked after first order) |
| DELETE | `/api/brand/campaigns/:campaignId` | Soft-delete campaign                       |

## Products (2 endpoints)

| Method | Path                          | Auth        | Description                            |
| ------ | ----------------------------- | ----------- | -------------------------------------- |
| GET    | `/api/products`               | Yes (buyer) | List available products/deals          |
| POST   | `/api/deals/:dealId/redirect` | Yes (buyer) | Track redirect → `{ preOrderId, url }` |

## Orders (5 endpoints)

| Method | Path                               | Auth        | Description                                  |
| ------ | ---------------------------------- | ----------- | -------------------------------------------- |
| GET    | `/api/orders/user/:userId`         | Yes         | User orders (self or privileged)             |
| POST   | `/api/orders`                      | Yes (buyer) | Create/update order                          |
| POST   | `/api/orders/claim`                | Yes (buyer) | Submit proof                                 |
| GET    | `/api/orders/:orderId/proof/:type` | Yes         | Get order proof (review/rating/returnWindow) |
| GET    | `/api/orders/:orderId/audit`       | Yes         | Order audit trail                            |

## Tickets (4 endpoints)

| Method | Path               | Auth | Description                   |
| ------ | ------------------ | ---- | ----------------------------- |
| GET    | `/api/tickets`     | Yes  | List tickets (scoped by role) |
| POST   | `/api/tickets`     | Yes  | Create ticket                 |
| PATCH  | `/api/tickets/:id` | Yes  | Update ticket status          |
| DELETE | `/api/tickets/:id` | Yes  | Soft-delete ticket            |

## Notifications — `/api/notifications` (4 endpoints)

| Method | Path                                 | Auth | Description                  |
| ------ | ------------------------------------ | ---- | ---------------------------- |
| GET    | `/api/notifications`                 | Yes  | List notifications           |
| GET    | `/api/notifications/push/public-key` | No   | VAPID public key             |
| POST   | `/api/notifications/push/subscribe`  | Yes  | Register push subscription   |
| DELETE | `/api/notifications/push/subscribe`  | Yes  | Unregister push subscription |

## Media (1 endpoint)

| Method | Path               | Auth | Description                |
| ------ | ------------------ | ---- | -------------------------- |
| GET    | `/api/media/image` | No   | Image proxy (query: `url`) |

## AI — `/api/ai` (6 endpoints)

| Method | Path                    | Auth            | Description                           |
| ------ | ----------------------- | --------------- | ------------------------------------- |
| POST   | `/api/ai/chat`          | Optional        | AI chat (rate-limited, 10MB body cap) |
| GET    | `/api/ai/status`        | No              | AI service status                     |
| POST   | `/api/ai/check-key`     | Yes (admin/ops) | Validate Gemini API key               |
| POST   | `/api/ai/verify-proof`  | Optional        | Verify order proof screenshot         |
| POST   | `/api/ai/verify-rating` | Optional        | Verify rating screenshot              |
| POST   | `/api/ai/extract-order` | Optional        | Extract order details from screenshot |

## Google Sheets — `/api/sheets` (1 endpoint)

| Method | Path                 | Auth | Description                 |
| ------ | -------------------- | ---- | --------------------------- |
| POST   | `/api/sheets/export` | Yes  | Export data to Google Sheet |

## Google OAuth — `/api/google` (4 endpoints)

| Method | Path                     | Auth | Description              |
| ------ | ------------------------ | ---- | ------------------------ |
| GET    | `/api/google/auth`       | Yes  | Get OAuth consent URL    |
| GET    | `/api/google/callback`   | No   | OAuth callback handler   |
| GET    | `/api/google/status`     | Yes  | Google connection status |
| POST   | `/api/google/disconnect` | Yes  | Revoke Google tokens     |

---

## Notes

- Global rate limit applies to all routes; auth routes have stricter limits (30 req / 5 min in production).
- JSON body size capped at 10MB.
- SSE realtime connects directly to backend (cross-origin) — CORS must be configured.
- For RBAC matrix: `docs/RBAC_MATRIX.md`
- For backend tests: `backend/tests/rbac.policy.spec.ts`
