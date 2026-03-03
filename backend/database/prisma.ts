/**
 * Prisma client singleton for the MOBO backend.
 *
 * Usage:
 *   import { prisma } from '../database/prisma.js';
 *
 * The client is lazily initialised on first access or by calling `connectPrisma()`.
 * In tests it is skipped when DATABASE_URL is not configured.
 *
 * Uses standard PostgreSQL with connection pooling via @prisma/adapter-pg.
 * Supports SSL/TLS when sslmode=require is set in DATABASE_URL.
 */
import { PrismaClient } from '../generated/prisma/client.js';
import type { TlsOptions } from 'node:tls';
import { dbLog, logEvent } from '../config/logger.js';
import { logDatabaseEvent } from '../config/appLogs.js';

let _prisma: PrismaClient | null = null;
let _connecting: Promise<void> | null = null;

/**
 * Whether Prisma/PG is available. Returns false when DATABASE_URL is not set
 * or when the client could not connect.
 */
export function isPrismaAvailable(): boolean {
  return _prisma !== null;
}

/**
 * Return the shared Prisma client instance (or null when PG is unavailable).
 */
export function getPrisma(): PrismaClient | null {
  return _prisma;
}

/**
 * Convenience getter that throws if Prisma is not connected.
 */
export function prisma(): PrismaClient {
  if (!_prisma) throw new Error('Prisma client is not connected. Call connectPrisma() first or check isPrismaAvailable().');
  return _prisma;
}

/**
 * Parse DATABASE_URL and build a clean pg Pool config with SSL support.
 * 
 * Handles:
 * - sslmode=require / verify-ca / verify-full → ssl: { rejectUnauthorized: true }
 * - sslmode=prefer / allow → ssl: { rejectUnauthorized: false }
 * - channel_binding=require → retained in connection string
 * - currentSchema / schema → extracted for PrismaPg adapter
 * - Strips non-standard params that the pg driver doesn't understand
 */
function buildPoolConfig(url: string) {
  const parsedUrl = new URL(url);

  // Extract PostgreSQL schema name (supports both ?schema= and ?currentSchema=)
  const pgSchema =
    parsedUrl.searchParams.get('currentSchema') ||
    parsedUrl.searchParams.get('schema') ||
    undefined;

  // Determine SSL mode from URL params
  const sslmode = parsedUrl.searchParams.get('sslmode') || 'disable';
  const requireSsl = ['require', 'verify-ca', 'verify-full'].includes(sslmode);
  const preferSsl = ['prefer', 'allow'].includes(sslmode);

  // Build SSL config for the pg driver
  let ssl: boolean | TlsOptions | undefined;
  if (requireSsl) {
    ssl = {
      rejectUnauthorized: ['verify-ca', 'verify-full'].includes(sslmode),
      // For sslmode=require, we enforce encrypted transport but allow
      // self-signed or CA-signed certs on managed hosting (Neon, Render, etc.)
    };
  } else if (preferSsl) {
    ssl = { rejectUnauthorized: false };
  }
  // When sslmode=disable or not set, ssl remains undefined (no TLS).

  // Strip params that pg Pool doesn't understand — pass only standard libpq params.
  // The pg driver handles: host, port, database, user, password, ssl, application_name, etc.
  // It does NOT handle: sslmode, currentSchema, schema, channel_binding (these are libpq-only).
  const paramsToStrip = ['sslmode', 'currentSchema', 'schema', 'channel_binding'];
  for (const p of paramsToStrip) {
    parsedUrl.searchParams.delete(p);
  }
  const cleanUrl = parsedUrl.toString();

  const isProd = process.env.NODE_ENV === 'production';

  const poolConfig: Record<string, unknown> = {
    connectionString: cleanUrl,
    // Pool sizing: production needs enough connections for burst traffic.
    // For 100k concurrent users, most hosting (Neon/Render) supports 50-100 connections.
    // With PgBouncer or Prisma Accelerate in front, this can be higher.
    max: parseInt(process.env.PG_POOL_MAX || (isProd ? '30' : '10'), 10),
    min: parseInt(process.env.PG_POOL_MIN || (isProd ? '5' : '2'), 10),
    idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT || '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.PG_CONNECT_TIMEOUT || '5000', 10),
    // Statement timeout prevents runaway queries from blocking the pool.
    statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT || '30000', 10),
    // Idle-in-transaction timeout prevents abandoned transactions from holding locks.
    idle_in_transaction_session_timeout: parseInt(process.env.PG_IDLE_IN_TX_TIMEOUT || '60000', 10),
    // TCP keepalive: detect broken connections before they cause timeout cascades.
    keepAlive: true,
    keepAliveInitialDelayMillis: parseInt(process.env.PG_KEEPALIVE_DELAY || '10000', 10),
    // Automatically reap connections above `min` if they've been idle for this long.
    allowExitOnIdle: !isProd,
  };

  if (ssl) {
    poolConfig.ssl = ssl;
  }

  // Set search_path so $queryRaw calls resolve unqualified table names correctly.
  if (pgSchema) {
    poolConfig.options = `-c search_path=${pgSchema},public`;
  }

  return { poolConfig, pgSchema, sslmode };
}

/**
 * Connect to PostgreSQL via Prisma with connection pooling.
 * Safe to call multiple times.  Retries up to `maxRetries` with exponential
 * back-off so transient network hiccups don't cause a cascade of failures.
 * Returns silently when DATABASE_URL is not configured (PG is optional).
 */
export async function connectPrisma(maxRetries = 3): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    dbLog.info('DATABASE_URL not set – PostgreSQL connection skipped');
    return;
  }

  if (_prisma) return;
  if (_connecting) return _connecting;

  _connecting = (async () => {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // In dev, route 'query' events ONLY to our slow-query listener
        // (emit: 'event') so they never flood stdout. In prod, only errors.
        const isDev = process.env.NODE_ENV === 'development';
        const logConfig = isDev
          ? [
              { emit: 'event' as const, level: 'query' as const },
              { emit: 'stdout' as const, level: 'warn' as const },
              { emit: 'stdout' as const, level: 'error' as const },
            ]
          : [{ emit: 'stdout' as const, level: 'error' as const }];

        // Standard PostgreSQL with connection pooling + SSL
        const { PrismaPg } = await import('@prisma/adapter-pg');
        const pg = await import('pg');
        const { poolConfig, pgSchema, sslmode } = buildPoolConfig(url);
        const pool = new pg.default.Pool(poolConfig as any);
        _pool = pool; // Expose for metrics
        pool.on('error', (err: Error) => {
          dbLog.error('PG pool background error', { error: err.message });
        });
        const adapter = new PrismaPg(pool, pgSchema ? { schema: pgSchema } : undefined);
        const client = new PrismaClient({ adapter, log: logConfig });

        // Log slow queries (>200ms) in development for performance debugging
        if (isDev) {
          client.$on('query' as never, (event: any) => {
            const duration = event.duration;
            if (duration > 200) {
              dbLog.warn(`Slow PG query (${duration}ms): ${String(event.query).slice(0, 200)}`, {
                duration,
                params: event.params ? String(event.params).slice(0, 100) : undefined,
              });
              logDatabaseEvent('SLOW_QUERY', {
                durationMs: duration,
                metadata: { query: String(event.query).slice(0, 200) },
              });
            }
          });
        }

        const sslLabel = sslmode === 'disable' ? 'off' : sslmode;
        dbLog.info(`PostgreSQL adapter ready (pool max=${poolConfig.max}, schema=${pgSchema ?? 'public'}, ssl=${sslLabel})`);

        // Run a lightweight query to verify connectivity upfront.
        await client.$queryRaw`SELECT 1`;
        _prisma = client;
        logDatabaseEvent('CONNECTED', {
          durationMs: 0,
          metadata: {
            poolMax: poolConfig.max,
            poolMin: poolConfig.min,
            schema: pgSchema ?? 'public',
            ssl: sslLabel,
            attempt,
          },
        });
        logEvent('info', 'Connected to PostgreSQL successfully', {
          domain: 'db',
          eventName: 'PG_CONNECTED',
          metadata: {
            poolMax: poolConfig.max,
            poolMin: poolConfig.min,
            schema: pgSchema ?? 'public',
            ssl: sslLabel,
            attempt,
          },
        });
        return; // success — break out of retry loop
      } catch (err) {
        const isLastAttempt = attempt === maxRetries;
        const msg = `PostgreSQL connection attempt ${attempt}/${maxRetries} failed`;
        if (isLastAttempt) {
          logDatabaseEvent('DISCONNECTED', {
            error: err instanceof Error ? err : new Error(String(err)),
            metadata: { attempt, maxRetries, errorCode: (err as any).code },
          });
          logEvent('error', msg, {
            domain: 'db',
            eventName: 'PG_CONNECTION_FAILED',
            errorCode: (err as any).code,
            stack: err instanceof Error ? err.stack : undefined,
            metadata: { attempt, maxRetries },
          });
          // All retries exhausted — PostgreSQL is unavailable.
          _prisma = null;
        } else {
          dbLog.warn(`${msg} – retrying in ${attempt}s…`, { error: (err as Error).message });
          await new Promise(r => setTimeout(r, attempt * 1000));
        }
      }
    }
  })();

  try {
    await _connecting;
  } finally {
    _connecting = null;
  }
}

/**
 * Lightweight ping to check if the PG connection is alive.
 * Attempts auto-reconnection (once) if the connection has dropped.
 * Returns true if the connection is healthy, false otherwise.
 * Used by the health endpoint for real connectivity checks.
 */
export async function pingPg(): Promise<boolean> {
  if (!_prisma) return false;
  try {
    await _prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (err) {
    // Connection may have dropped — attempt a single reconnection.
    dbLog.warn('PG ping failed — attempting reconnection', {
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      _prisma = null; // Clear stale client
      await connectPrisma(1); // Single attempt reconnect
      if (_prisma) {
        dbLog.info('PG reconnected successfully after ping failure');
        return true;
      }
    } catch { /* reconnection failed — fall through */ }
    return false;
  }
}

/* ── Pool metrics (active, idle, waiting) for observability ───────── */
let _pool: any = null;
export function getPoolMetrics() {
  if (!_pool) return { totalCount: 0, idleCount: 0, waitingCount: 0 };
  return {
    totalCount: _pool.totalCount ?? 0,
    idleCount: _pool.idleCount ?? 0,
    waitingCount: _pool.waitingCount ?? 0,
  };
}

/**
 * Gracefully disconnect the Prisma client (used during shutdown).
 * Uses a 5-second timeout to prevent hanging when PG is unreachable.
 */
export async function disconnectPrisma(): Promise<void> {
  if (_prisma) {
    const client = _prisma;
    _prisma = null; // Mark as disconnected immediately to prevent new queries
    try {
      await Promise.race([
        client.$disconnect(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('Prisma disconnect timed out after 5s')), 5000)
        ),
      ]);
    } catch (err) {
      dbLog.warn('Prisma disconnect error (best-effort)', { error: err instanceof Error ? err.message : String(err) });
    }
  }
}
