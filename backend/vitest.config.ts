import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Load .env so DATABASE_URL (PostgreSQL) is available in tests.
const rootDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(rootDir, '.env') });

export default defineConfig({
  test: {
    root: rootDir,
    include: ['tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/build/**', '**/coverage/**', '**/e2e/**'],
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // Forks are more reliable than threads for ESM in CI/Windows.
    pool: 'forks',
    // Keep a single worker and disable isolation to prevent connection pool races.
    maxWorkers: 1,
    isolate: false,
    hookTimeout: 120_000,
    testTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
    },
  },
});
