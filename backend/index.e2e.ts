import 'dotenv/config';

// E2E must never use a developer's real API keys.
process.env.GEMINI_API_KEY = '';

// Force a safe runtime mode for E2E.
process.env.NODE_ENV = 'test';

import { loadEnv } from './config/env.js';
import { connectPrisma } from './database/prisma.js';
import { createApp } from './app.js';
import { startupLog } from './config/logger.js';
import { setReady } from './config/lifecycle.js';

async function tryRunE2ESeed() {
  // In E2E we run under tsx (TypeScript); import the TS module directly.
  const mod = await import('./seeds/e2e.ts');
  if (typeof (mod as any).seedE2E !== 'function') {
    throw new Error('Missing export seedE2E in ./seeds/e2e.ts');
  }
  await (mod as any).seedE2E();
}

async function main() {
  startupLog.info('E2E backend starting', {
    nodeVersion: process.version,
    cwd: process.cwd(),
    hasDbUrl: !!process.env.DATABASE_URL,
    nodeEnv: process.env.NODE_ENV,
    ci: !!process.env.CI,
  });

  const env = loadEnv();
  startupLog.info('Environment loaded', { port: env.PORT });

  // Connect PostgreSQL -- primary and only database.
  await connectPrisma();
  startupLog.info('PostgreSQL connected');

  // Safe, idempotent upsert of E2E test accounts (no deletes).
  // Non-fatal: if seed fails, the server starts anyway so tests get
  // meaningful assertion errors instead of a 180-second timeout.
  let seedOk = false;
  try {
    await tryRunE2ESeed();
    seedOk = true;
    startupLog.info('E2E seed completed successfully');
  } catch (seedErr) {
    startupLog.error('E2E seed failed, server will start without seed data', {
      error: seedErr instanceof Error ? seedErr.message : String(seedErr),
      stack: seedErr instanceof Error ? seedErr.stack : undefined,
    });
  }

  const app = createApp(env);

  const server = app.listen(env.PORT, () => {
    setReady(true);
    startupLog.info(`E2E backend listening on :${env.PORT}`, { seedOk });
  });

  // Surface bind errors immediately so Playwright does not wait on a dead server.
  server.on('error', (err) => {
    startupLog.error('E2E server bind error', { error: err });
    process.exit(1);
  });
}

main().catch((err) => {
  startupLog.error('Fatal startup error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
