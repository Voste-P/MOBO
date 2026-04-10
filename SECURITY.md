# Security Policy — MOBO

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| main    | :white_check_mark: |
| develop | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly.

**Do NOT open a public GitHub issue.**

1. Email: **security@mobo.app** (or the repository owner directly)
2. Include: description, steps to reproduce, impact assessment
3. We will acknowledge within **48 hours** and provide a fix timeline within **7 days**

## Security Measures

### Authentication & Authorization
- JWT-based authentication with zero-trust model — user record re-fetched from DB on every request
- Role-based access control (RBAC) with six roles: `shopper`, `mediator`, `agency`, `brand`, `ops`, `admin`
- Ownership scoping on all data-mutating endpoints (users can only modify their own resources)
- Invite-based registration — no open sign-ups; every account tied to an invite code

### Input & Request Security
- Zod schema validation on every endpoint (request body, query params, route params)
- Request body size limit: 10 MB maximum
- Suspicious pattern detection middleware — blocks SQL injection, path traversal, and script payloads in all request fields
- Parameterized queries via Prisma ORM — no raw string interpolation in SQL
- Content-Security-Policy headers on all frontend apps

### Financial Integrity
- Atomic wallet operations via raw SQL with ceiling checks (prevents race-condition overdrafts)
- Idempotency keys on all wallet mutations (credit/debit) — prevents duplicate transactions
- Wallet balance limits enforced atomically (configurable via `WALLET_MAX_BALANCE_PAISE`)
- All money stored as integer paise — no floating-point arithmetic
- Optimistic concurrency via `version` column on wallets

### Rate Limiting
- Authentication endpoints (login, register, forgot-password) — rate-limited per IP
- Sensitive operations — rate-limited per user

### AI & External Service Safety
- AI requests use circuit breaker pattern with exponential backoff
- Abort controllers cancel in-flight AI requests on user navigation/cancellation
- AI confidence scores are advisory only — never auto-approve without human review threshold

### Infrastructure
- Secrets managed via environment variables — never committed to source
- All GitHub Actions pinned to full SHA (supply-chain protection)
- Soft-delete rule — no hard deletes in production (full audit trail)
- Structured audit logging on all admin, financial, and user-lifecycle operations
- XSS prevention via React automatic escaping + CSP headers
- CORS restricted to known origins
