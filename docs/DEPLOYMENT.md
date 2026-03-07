# Deployment

This doc is the minimal, copy/paste oriented setup.

If you do not have custom domains yet, use: `docs/DEPLOYMENT_RENDER_VERCEL_NO_DOMAIN.md`.

Before deploying, verify locally from repo root:

- Clean generated artifacts (optional): `npm run clean`
- Build everything: `npm run build`
- Run backend tests: `npm run test:backend`
- Run E2E tests: `npm run test:e2e`

---

## Branch Strategy

| Branch    | Purpose            | Backend           | Database   | Frontends (Vercel)            |
| --------- | ------------------ | ----------------- | ---------- | ----------------------------- |
| `main`    | **Production**     | Production server | PostgreSQL | Production deployments        |
| `develop` | **Staging / Test** | Staging server    | PostgreSQL | Preview / staging deployments |

**Workflow:**

1. All new features / changes go into `develop` first
2. Test on staging (separate backend service + staging database schema `buzzma_test`)
3. When confirmed stable, merge `develop` → `main` via Pull Request
4. Production auto-deploys from `main`

**Rules:**

- Never push directly to `main` — always merge from `develop`
- `main` is always stable and live for real users
- `develop` is for testing — breaking it is OK

---

## Live URLs

### Production

| Service  | URL                           | Branch |
| -------- | ----------------------------- | ------ |
| Backend  | _(your server URL)_           | `main` |
| Buyer    | https://www.buzzma.in         | `main` |
| Mediator | https://www.mediatorbuzzma.in | `main` |
| Agency   | https://www.agencybuzzma.in   | `main` |
| Brand    | https://www.brandbuzzma.in    | `main` |
| Admin    | https://moboadmin.vercel.app  | `main` |

### Database Naming

| Environment | Prisma Schema       | Database   |
| ----------- | ------------------- | ---------- |
| Production  | `buzzma_production` | PostgreSQL |
| Staging     | `buzzma_test`       | PostgreSQL |
| E2E tests   | `buzzma_test`       | PostgreSQL |

---

## Backend

Recommended: Any Node.js host (e.g., Railway, Fly.io, a VPS).

- Build: `npm install --include=dev; npm --prefix backend run build`
- Start: `npm --prefix backend run start`

If you see `TS2688: Cannot find type definition file for 'node'`, it means devDependencies (like `@types/node`) were not installed during build. Fix by using `--include=dev` as above.

Required env vars:

- `NODE_ENV=production`
- `DATABASE_URL=postgresql://user:pass@host:5432/db?currentSchema=buzzma_production&sslmode=require`
- `JWT_ACCESS_SECRET=...` (>= 32 chars)
- `JWT_REFRESH_SECRET=...` (>= 32 chars)
- `CORS_ORIGINS=https://www.buzzma.in,https://www.mediatorbuzzma.in,https://www.agencybuzzma.in,https://www.brandbuzzma.in,https://moboadmin.vercel.app`

Optional env vars:

- `LOG_LEVEL=debug` — Override log level (default: `info` in production, `debug` in development)
- `LOG_FORMAT=pretty` — Use colorful dev-style console logs in production (default: `compact` single-line format for Docker/Render)

> **Tip:** Set `LOG_FORMAT=pretty` on your production Render service to get the same colorful, readable logs you see locally on the `develop` branch.

Health check:

- `GET /api/health`

### Staging Backend

Create a second backend service (or environment) for the `develop` branch:

1. Same build/start commands as production
2. Environment variables — same as production **except**:
   - `DATABASE_URL=...?currentSchema=buzzma_test`
   - `CORS_ORIGINS=<staging portal origins>`
   - Different `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`

## Admin login (production)

Admin/ops login is **username/password** (not mobile).

To ensure the admin exists in production, set these env vars on your server:

- `ADMIN_SEED_USERNAME`
- `ADMIN_SEED_PASSWORD`
- `ADMIN_SEED_MOBILE`
- `ADMIN_SEED_NAME`

Then either:

- Temporarily set `SEED_ADMIN=true` for one deploy (recommended), verify login, then remove it.
- Or run `npm -w @mobo/backend run seed:admin` manually against the production DB.

Note: in `NODE_ENV=production`, the seed refuses to run if the admin seed variables are missing/placeholder.

## Frontends (Vercel)

Deploy each portal as its own Vercel project with Root Directory set to:

- `apps/buyer-app`
- `apps/mediator-app`
- `apps/agency-web`
- `apps/brand-web`
- `apps/admin-web`

Each portal must set:

- `NEXT_PUBLIC_API_PROXY_TARGET=https://<your-backend-url>`

Current production portal URLs:

| Portal   | Vercel URL                    |
| -------- | ----------------------------- |
| Buyer    | https://www.buzzma.in         |
| Mediator | https://www.mediatorbuzzma.in |
| Agency   | https://www.agencybuzzma.in   |
| Brand    | https://www.brandbuzzma.in    |
| Admin    | https://moboadmin.vercel.app  |

That keeps the UI contract stable (`/api/*` on the client, rewritten server-side to the backend).
