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
  const env = loadEnv();

  // Connect PostgreSQL — primary and only database.
  await connectPrisma();

  // Safe, idempotent upsert of E2E test accounts (no deletes).
  await tryRunE2ESeed();
  startupLog.info('E2E seed completed successfully');

  const app = createApp(env);

  const server = app.listen(env.PORT, () => {
    setReady(true);
    startupLog.info(`E2E backend listening on :${env.PORT}`);
  });

  // Surface bind errors immediately so Playwright doesn’t wait 120s on a dead server.
  server.on('error', (err) => {
    startupLog.error('E2E server bind error', { error: err });
    process.exitCode = 1;
  });
}

main().catch((err) => {
  startupLog.error('Fatal startup error', { error: err });
  process.exitCode = 1;
});
