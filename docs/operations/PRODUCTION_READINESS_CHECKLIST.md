# Production readiness checklist

This is a concise, actionable checklist for preparing BUZZMA for production deployments.

## Build + test (must be green)

- `npm run lint`
- `npm run build:backend`
- `npm run test:backend`
- `npm run build:apps`
- Optional: `npm run test:e2e`

## Backend env (Node host)

Required:

- `NODE_ENV=production`
- `PORT` (often set by host)
- `DATABASE_URL=<PostgreSQL connection string>`
- `JWT_ACCESS_SECRET=<secure random string, >= 32 chars>`
- `JWT_REFRESH_SECRET=<secure random string, >= 32 chars>`
- `CORS_ORIGINS=<comma-separated list of allowed portal origins>`

Notes:

- `CORS_ORIGINS` is **required** in production and should be tight.
- Use exact origins when possible; wildcard/hostname entries are supported (less strict), e.g. `https://*.vercel.app` or `.vercel.app`.

Optional:

- `GEMINI_API_KEY` (AI routes return 503 when not configured)

## Portal env (Vercel/Next host)

- `NEXT_PUBLIC_API_PROXY_TARGET=<backend base URL>`
  - Example: `https://<render-backend-host>`
  - In local dev: defaults to `http://localhost:8080`

## Realtime (SSE)

- Health check: `GET /api/realtime/health` should return `{ "status": "ok" }`.
- Stream: `GET /api/realtime/stream` requires auth and should emit `ready` then periodic `ping`.
- Producers: realtime events must include an explicit `audience` (fail-closed).

## Security essentials

- Verify `CORS_ORIGINS` includes every portal origin.
- Confirm `JWT_*_SECRET` are non-placeholder and not committed.
- Ensure admin/ops accounts are protected (strong passwords; rotate if leaked).
- Confirm rate-limits are enabled in production (`backend/app.ts`).

## Operational sanity

- Logs: verify the host captures stdout/stderr.
- Health: `GET /api/health` should show `status: ok` and `database: connected`.
- DB migrations: ensure `prisma migrate deploy` has been run on the production database.

## Rollout notes

- If deploying portals before backend, collect portal URLs first and set `CORS_ORIGINS` accordingly.
- If deploying backend first, start with a temporary `CORS_ORIGINS` allowlist and update after portals are deployed.

See also:

- `docs/operations/DEPLOYMENT.md`
- `docs/operations/DEPLOYMENT_RENDER_VERCEL_NO_DOMAIN.md`
- `docs/REALTIME.md`
