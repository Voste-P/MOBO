import { loadDotenv } from './config/dotenvLoader.js';

loadDotenv();
import { loadEnv } from './config/env.js';
import { connectPrisma, disconnectPrisma, isPrismaAvailable } from './database/prisma.js';
import { createApp, getInFlightCount, waitForDrain } from './app.js';
import type { Server } from 'node:http';
import { startupLog, logEvent, getSystemMetrics } from './config/logger.js';
import { logAvailabilityEvent, logDatabaseEvent, startAvailabilityMonitor, stopAvailabilityMonitor } from './config/appLogs.js';
import { setReady, setShuttingDown } from './config/lifecycle.js';
import { startCoolingPeriodSettler, stopCoolingPeriodSettler } from './services/coolingPeriodSettler.js';

// ── Lifecycle state ──────────────────────────────────────────────────
let server: Server | null = null;
let shuttingDown = false;
const shutdownTimeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 30_000;

// ── Graceful shutdown ────────────────────────────────────────────────
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  setShuttingDown(true);
  setReady(false); // immediately stop accepting new traffic via health probes

  startupLog.info(`Received ${signal}. Shutting down gracefully…`, {
    inFlightRequests: getInFlightCount(),
    shutdownTimeoutMs,
  });

  logAvailabilityEvent('APPLICATION_SHUTDOWN_START', {
    component: 'backend',
    status: 'stopping',
    uptimeSeconds: Math.floor(process.uptime()),
    metadata: { signal, inFlightRequests: getInFlightCount() },
  });

  const forceTimer = setTimeout(() => {
    startupLog.error('Force shutdown after timeout', { inFlightRequests: getInFlightCount() });
    process.exit(1);
  }, shutdownTimeoutMs);
  forceTimer.unref();

  try {
    // 1. Stop accepting new connections
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });

    // 2. Wait for in-flight requests to drain (up to half the shutdown budget)
    const drainBudget = Math.floor(shutdownTimeoutMs * 0.6);
    const currentInFlight = getInFlightCount();
    if (currentInFlight > 0) {
      startupLog.info(`Draining ${currentInFlight} in-flight request(s)…`, { drainBudget });
      await waitForDrain(drainBudget);
    }
  } catch (err) {
    startupLog.error('Error while closing HTTP server', { error: err });
  }

  try {
    await disconnectPrisma();
  } catch (err) {
    startupLog.error('Error while disconnecting Prisma', { error: err });
  } finally {
    clearTimeout(forceTimer);
    stopAvailabilityMonitor();
    stopCoolingPeriodSettler();
    logAvailabilityEvent('APPLICATION_SHUTDOWN_COMPLETE', {
      component: 'backend',
      status: 'down',
      uptimeSeconds: Math.floor(process.uptime()),
    });
    startupLog.info('Shutdown complete.');
  }
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const env = loadEnv();

  logAvailabilityEvent('APPLICATION_STARTING', {
    component: 'backend',
    status: 'starting',
    metadata: {
      nodeEnv: env.NODE_ENV,
      port: env.PORT,
      nodeVersion: process.version,
      platform: process.platform,
    },
  });

  // Connect PostgreSQL (Prisma) — PRIMARY and ONLY database.
  const dbStart = performance.now();
  await connectPrisma();

  if (!isPrismaAvailable()) {
    logAvailabilityEvent('DATABASE_ERROR', {
      component: 'postgresql',
      status: 'down',
    });
    startupLog.error('PostgreSQL connection failed. Cannot start without primary database.');
    process.exit(1);
  }

  const dbConnectMs = Math.round(performance.now() - dbStart);
  logDatabaseEvent('CONNECTED', { durationMs: dbConnectMs });
  logAvailabilityEvent('DATABASE_CONNECTED', {
    component: 'postgresql',
    status: 'up',
    responseTimeMs: dbConnectMs,
  });
  startupLog.info('PostgreSQL connected — primary database ready');

  // ── Schema sanity check ─────────────────────────────────────────────
  // Catch migration drift at startup instead of failing on first request.
  try {
    const { prisma: getPrisma } = await import('./database/prisma.js');
    const db = getPrisma();
    await db.user.findFirst({ where: { isDeleted: false }, select: { id: true }, take: 1 });
    startupLog.info('Schema sanity check passed (isDeleted column accessible)');
  } catch (schemaErr: any) {
    const code = (schemaErr as any)?.code;
    if (code === 'P2022' || code === 'P2010' || code === 'P2023') {
      startupLog.error(
        'SCHEMA MISMATCH: Database columns do not match Prisma schema. ' +
        'Run "npx prisma migrate deploy" to apply pending migrations.',
        { prismaCode: code, message: schemaErr?.message },
      );
      process.exit(1);
    }
    // Non-schema errors (e.g. empty table) are fine — just log and continue
    startupLog.warn('Schema sanity check query failed (non-fatal)', { error: schemaErr?.message });
  }

  const app = createApp(env);

  server = app.listen(env.PORT, () => {
    // ── Server hardening for reverse proxy (ALB/NGINX/Render) ──
    // Default keepAliveTimeout (5s) is shorter than most LB idle timeouts (60s),
    // causing 502 errors. Set to 65s to outlast them.
    server!.keepAliveTimeout = 65_000;
    server!.headersTimeout = 66_000; // must exceed keepAliveTimeout

    // Mark ready — health probes can now return 200.
    setReady(true);

    const metrics = getSystemMetrics();
    logEvent('info', `Backend listening on :${env.PORT}`, {
      domain: 'system',
      eventName: 'APPLICATION_STARTED',
      metadata: {
        nodeEnv: env.NODE_ENV,
        port: env.PORT,
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        shutdownTimeoutMs,
        ...metrics,
      },
    });

    logAvailabilityEvent('APPLICATION_READY', {
      component: 'backend',
      status: 'up',
      uptimeSeconds: Math.round(process.uptime()),
      metadata: { port: env.PORT, nodeEnv: env.NODE_ENV },
    });

    // Start periodic health/memory monitoring (every 5 min, warn at 512MB RSS)
    startAvailabilityMonitor();

    // Start cooling period auto-settlement (every hour)
    startCoolingPeriodSettler(env);
  });
}

// ── Process event handlers ───────────────────────────────────────────
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logEvent('error', 'Unhandled promise rejection', {
    domain: 'system',
    eventName: 'UNHANDLED_REJECTION',
    stack: reason instanceof Error ? reason.stack : String(reason),
    metadata: { reason: String(reason), ...getSystemMetrics() },
  });
  process.exitCode = 1;
  void shutdown('unhandledRejection');
});
process.on('uncaughtException', (err) => {
  logEvent('error', `Uncaught exception: ${err.message}`, {
    domain: 'system',
    eventName: 'UNCAUGHT_EXCEPTION',
    errorCode: (err as any).code,
    stack: err.stack,
    metadata: { name: err.name, ...getSystemMetrics() },
  });
  process.exitCode = 1;
  void shutdown('uncaughtException');
});
// Log deprecation warnings in dev/staging so they're caught before production.
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning') {
    startupLog.warn(`Node.js deprecation: ${warning.message}`, { code: (warning as any).code });
  }
});
main().catch((err) => {
  logEvent('error', `Fatal startup error: ${err.message}`, {
    domain: 'system',
    eventName: 'STARTUP_FATAL',
    stack: err instanceof Error ? err.stack : undefined,
    metadata: { ...getSystemMetrics() },
  });
  process.exitCode = 1;
  // Force exit — without this, Winston transports and intervals keep the event loop alive
  // and the process hangs indefinitely with no server listening.
  setTimeout(() => process.exit(1), 2000).unref();
});
