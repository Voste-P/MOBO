/**
 * Vitest setup file: connects Prisma (PostgreSQL) before all tests.
 *
 * Strategy:
 * 1. If Docker is available → spin up a fresh PostgreSQL via testcontainers
 * 2. Else → fall back to DATABASE_URL from .env (remote / existing DB)
 */
import { beforeAll, afterAll } from 'vitest';
import { connectPrisma, disconnectPrisma, isPrismaAvailable } from '../database/prisma.js';
import { execSync } from 'node:child_process';

let pgContainer: any = null;

async function tryTestcontainers(): Promise<boolean> {
  try {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
      .start();
    process.env.DATABASE_URL = pgContainer.getConnectionUri();
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  const containerStarted = await tryTestcontainers();

  if (!containerStarted && !process.env.DATABASE_URL) {
    process.stderr.write(
      '\n⚠  [test setup] Docker not available and no DATABASE_URL set – PG tests will fail.\n\n'
    );
    return;
  }

  if (!containerStarted) {
    // Using existing DATABASE_URL from .env
    process.stderr.write(
      '\n[test setup] Docker not available – using existing DATABASE_URL.\n\n'
    );
  }

  await connectPrisma(5);
  if (!isPrismaAvailable()) {
    process.stderr.write(
      '\n⚠  [test setup] PostgreSQL not available after 5 retries – PG-dependent tests will fail.\n\n'
    );
  }
}, 120_000);

afterAll(async () => {
  await disconnectPrisma();
  if (pgContainer) {
    await pgContainer.stop();
  }
});
