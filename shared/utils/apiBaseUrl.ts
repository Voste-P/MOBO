// ─Cross-platform env accessors (avoid `as any`) ───────────────────────
type EnvRecord = Record<string, string | undefined>;

/** Safely read a `process.env` variable (Node.js / Next.js). */
export function readProcessEnv(key: string): string | undefined {
  if (typeof process === 'undefined') return undefined;
  const env = (process as unknown as { env?: EnvRecord }).env;
  return env?.[key] ?? undefined;
}

/** Safely read an `import.meta.env` variable (Vite). */
function readViteEnv(key: string): string | undefined {
  if (typeof import.meta === 'undefined') return undefined;
  const env = (import.meta as unknown as { env?: EnvRecord }).env;
  return env?.[key] ?? undefined;
}

/** Safely read a globalThis property. */
export function readGlobal<T = unknown>(key: string): T | undefined {
  return (globalThis as unknown as Record<string, unknown>)[key] as T | undefined;
}

/**
 * Canonical API base URL resolver.
 *
 * Shared between `api.ts` and `realtime.ts` so there is a single source
 * of truth for environment-variable reading, proxy detection, and
 * local-dev fallback logic.
 *
 * Resolution order:
 *  1. `globalThis.__MOBO_API_URL__` (injected at runtime, e.g. Electron)
 *  2. `VITE_API_URL`               (Vite apps)
 *  3. `NEXT_PUBLIC_API_URL`        (Next.js apps – direct URL)
 *  4. Same-origin `/api` proxy     (when NEXT_PUBLIC_API_PROXY_TARGET is set
 *     and we're running in the browser)
 *  5. Localhost fallback            (`http://localhost:8080/api` for local dev)
 *  6. `/api`                        (catch-all relative path)
 */
export function getApiBaseUrl(): string {
  const fromGlobal = readGlobal<string>('__MOBO_API_URL__');

  const fromVite = readViteEnv('VITE_API_URL')
    ? String(readViteEnv('VITE_API_URL'))
    : undefined;

  const fromNext = readProcessEnv('NEXT_PUBLIC_API_URL')
    ? String(readProcessEnv('NEXT_PUBLIC_API_URL'))
    : undefined;

  const fromNextProxyTarget = readProcessEnv('NEXT_PUBLIC_API_PROXY_TARGET')
    ? String(readProcessEnv('NEXT_PUBLIC_API_PROXY_TARGET'))
    : undefined;

  // In Next.js deployments we rely on same-origin `/api/*` + Next rewrites.
  // This avoids CORS/preflight problems when env vars point at a different origin.
  const hasDirectApiUrl = Boolean(fromGlobal || fromVite || fromNext);
  const preferSameOriginProxy =
    !hasDirectApiUrl &&
    typeof window !== 'undefined' &&
    (String(readProcessEnv('NEXT_PUBLIC_API_PROXY_TARGET') || '').trim() ||
      String(readProcessEnv('NEXT_PUBLIC_API_URL') || '').trim());

  const fromProxy = preferSameOriginProxy
    ? '/api'
    : fromNextProxyTarget
      ? (() => {
          const raw = String(fromNextProxyTarget).trim();
          if (!raw) return undefined;
          const trimmed = raw.endsWith('/') ? raw.slice(0, -1) : raw;
          return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
        })()
      : undefined;

  let base = (fromGlobal || fromVite || fromNext || fromProxy || '/api').trim();

  // Defense-in-depth: reject obviously unsafe URL schemes
  if (base && !base.startsWith('/') && !base.startsWith('http://') && !base.startsWith('https://')) {
    base = '/api';
  }

  // Local dev fallback: if apps run on Next (300x) and backend on 8080,
  // talk to the backend directly unless overridden.
  if (base === '/api' && typeof window !== 'undefined') {
    const host = window.location.hostname;
    const isLocalhost = host === 'localhost' || host === '127.0.0.1';
    if (isLocalhost) base = 'http://localhost:8080/api';
  }

  return base.endsWith('/') ? base.slice(0, -1) : base;
}

/**
 * Like `getApiBaseUrl()` but guarantees an absolute URL (with origin) when
 * running in the browser.  This is needed for image-proxy `src` attributes
 * where a relative `/api` path won't work.
 */
export function getApiBaseAbsolute(): string {
  let base = getApiBaseUrl();
  if (base.startsWith('/') && typeof window !== 'undefined') {
    base = `${window.location.origin}${base}`;
  }
  return base.replace(/\/$/, '');
}

/**
 * Returns the direct backend API URL (bypassing Vercel/Next.js proxy).
 *
 * This is required for URLs that will be opened outside the browser session,
 * e.g. Excel HYPERLINK formulas, Google Sheets links, or email links.
 * Vercel rewrites only work for same-origin browser requests; external apps
 * like Excel cannot follow the proxy chain.
 *
 * Resolution order:
 *  1. `NEXT_PUBLIC_API_PROXY_TARGET` + `/api`  (the actual backend origin)
 *  2. `NEXT_PUBLIC_API_URL`                    (direct URL if set)
 *  3. Falls back to `getApiBaseAbsolute()`     (same-origin proxy as last resort)
 */
export function getDirectBackendUrl(): string {
  const proxyTarget = readProcessEnv('NEXT_PUBLIC_API_PROXY_TARGET')?.trim() || '';

  if (proxyTarget) {
    const base = proxyTarget.endsWith('/') ? proxyTarget.slice(0, -1) : proxyTarget;
    return base.endsWith('/api') ? base : `${base}/api`;
  }

  const directUrl = readProcessEnv('NEXT_PUBLIC_API_URL')?.trim() || '';

  if (directUrl) {
    return directUrl.endsWith('/') ? directUrl.slice(0, -1) : directUrl;
  }

  return getApiBaseAbsolute();
}
