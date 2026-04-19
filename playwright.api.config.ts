import { defineConfig } from '@playwright/test';

/**
 * Lightweight E2E config that runs API-only tests directly against backend:8080.
 * No Next.js portals needed — saves ~3GB RAM.
 * Usage: npx playwright test -c playwright.api.config.ts
 */
export default defineConfig({
  testDir: './e2e',
  reporter: [['list']],
  timeout: 180_000,
  expect: { timeout: 20_000 },
  use: {
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    baseURL: 'http://localhost:8080',
  },
  workers: 1,
  // No webServer — backend must already be running on port 8080
  testMatch: [
    /.*\.api\.spec\.ts$/,
  ],
});
