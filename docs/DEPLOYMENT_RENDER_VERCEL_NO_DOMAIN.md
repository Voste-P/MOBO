# Deploy (Render + Vercel) — No Custom Domain Yet

This guide gets you fully deployed on **Render (backend)** + **Vercel (frontends)** using the default `*.vercel.app` URLs, and explains what to update later when you buy/attach custom domains.

The system contract is:

- Each portal calls `/api/*`
- Each Next.js portal rewrites `/api/*` → `${NEXT_PUBLIC_API_PROXY_TARGET}/api/*`

So the only thing the portals need is the backend base URL.

## Step 0 — Decide your deployment order

Because the backend requires an allowlist of portal origins (`CORS_ORIGINS`), you have two practical options:

### Option A (recommended): Deploy portals first, then backend

1. Deploy the 5 portals to Vercel (you’ll immediately get 5 `https://<project>.vercel.app` URLs)
2. Put those URLs into Render `CORS_ORIGINS`
3. Deploy the backend on Render
4. Update each portal’s `NEXT_PUBLIC_API_PROXY_TARGET` to point at the Render backend

### Option B: Deploy backend first, then portals

1. Deploy backend on Render with a temporary `CORS_ORIGINS` (only local dev origins)
2. Deploy portals on Vercel to obtain their URLs
3. Update Render `CORS_ORIGINS` with the portal URLs and redeploy
4. Update each portal `NEXT_PUBLIC_API_PROXY_TARGET`

In both cases, **the portals won’t work in the browser until the backend `CORS_ORIGINS` includes the exact portal origins**.

## Step 1 — Backend on Render (Web Service)

Create a new **Web Service** pointing to this repo.

### Root Directory (important)

Render runs your commands from the configured **Root Directory**.

- If Root Directory is **blank** (repo root), use commands that target `backend/` (examples below).
- If Root Directory is set to **`backend`**, do **not** use `--prefix backend` (otherwise Render will look for `backend/backend/package.json`).

### Commands

- Build command:
  - Repo root Root Directory:
    - `npm install --include=dev; npm --prefix backend run build`
  - Root Directory = `backend`:
    - `npm install --include=dev; npm run build`
- Start command:
  - Repo root Root Directory:
    - `npm --prefix backend run start`
  - Root Directory = `backend`:
    - `npm run start`

Why `--include=dev`?

- The backend build runs TypeScript (`tsc`) which needs devDependencies like `@types/node`.
- Many hosts set `NODE_ENV=production` during build which can cause `npm install` to omit devDependencies, leading to:
  - `error TS2688: Cannot find type definition file for 'node'.`

Alternative to `--include=dev`:

- In Render environment variables, set `NPM_CONFIG_PRODUCTION=false` so devDependencies are installed during build.

### Health check

- Path: `/api/health`

### Required environment variables

Set these in Render:

- `NODE_ENV=production`
- `PORT=8080` (Render may set `PORT` automatically; keep it if they do)
- `DATABASE_URL=<your PostgreSQL connection string>`
- `JWT_ACCESS_SECRET=<strong random secret, >= 32 chars>`
- `JWT_REFRESH_SECRET=<strong random secret, >= 32 chars>`
- `CORS_ORIGINS=<comma-separated list of portal origins>`

Example **without custom domains** (use your actual Vercel URLs):

- `CORS_ORIGINS=https://buyer-app-xxxxx.vercel.app,https://mediator-app-xxxxx.vercel.app,https://agency-web-xxxxx.vercel.app,https://brand-web-xxxxx.vercel.app,https://admin-web-xxxxx.vercel.app,.vercel.app`

Notes:

- `CORS_ORIGINS` must be **origins only** (scheme + host), not paths.
- Adding `.vercel.app` (hostname suffix) allows all Vercel preview deployments automatically.
- For strict production, list exact portal origins only (remove `.vercel.app` suffix entry).

## Step 1.5 — Seed ONLY the admin user (production)

Your backend supports an **admin-only seed** that creates (or updates) a single admin user.

Recommended approach:

1. In Render env vars, set:

- `ADMIN_SEED_USERNAME`
- `ADMIN_SEED_PASSWORD`
- `ADMIN_SEED_MOBILE` (required by the schema; admin login still uses username/password)
- `ADMIN_SEED_NAME`

2. Temporarily set `SEED_ADMIN=true` and redeploy the backend.
3. After you verify admin login, set `SEED_ADMIN=false` (or remove it) and redeploy again.

Why temporarily?

- With `SEED_ADMIN=true`, the backend may update the admin profile on every restart.
- Once the admin exists, leaving `SEED_ADMIN` off avoids unintended credential drift.

Alternative:

- Run `npm -w @mobo/backend run seed:admin` against the production DB from a trusted machine that has the same environment variables set.

Important:

- In `NODE_ENV=production`, the seed will refuse to run if `ADMIN_SEED_USERNAME` or `ADMIN_SEED_PASSWORD` are missing/placeholder.

## Step 2 — Frontends on Vercel (5 projects)

Create **five** Vercel projects, one per portal.

### Root Directory (per project)

- Buyer: `apps/buyer-app`
- Mediator: `apps/mediator-app`
- Agency: `apps/agency-web`
- Brand: `apps/brand-web`
- Admin: `apps/admin-web`

### Environment variables (per project)

Set in Vercel:

- `NEXT_PUBLIC_API_PROXY_TARGET=https://<your-render-backend-host>`

Important:

- This must be the **backend base URL** (no `/api`).
- After changing `NEXT_PUBLIC_API_PROXY_TARGET`, redeploy the portal (Vercel does this automatically on env change).

## Step 3 — Quick verification

Once deployed:

1. Open the backend health check:
   - `https://<render-backend-host>/api/health`
2. Open each portal URL and try a login:
   - Admin portal is the fastest sanity check (it hits both auth + protected endpoints).

If a portal loads but API calls fail in the browser:

- Verify `NEXT_PUBLIC_API_PROXY_TARGET` is correct.
- Verify the portal origin is present (exactly) in Render `CORS_ORIGINS`.

## Later — When you add custom domains

When you attach custom domains in Vercel, you must update **only** these places:

1. Render `CORS_ORIGINS`
   - Add the new custom domain origins for each portal.
   - Keep the old `*.vercel.app` origins until you’re sure traffic is no longer using them.

2. Nothing else changes
   - `NEXT_PUBLIC_API_PROXY_TARGET` stays as your Render backend URL.
   - The backend base URL generally stays the same unless you also add a custom API domain.
