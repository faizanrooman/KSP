import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ARTIFACT_DIR, BASE_URL } from '../lib/env';

/**
 * UI/UX audit crawler (not part of the regular E2E run). Needs a stack with data — run the E2E suite once first.
 *   npx playwright test -c tests/e2e/audit/audit.config.ts [crawl|interact]
 * Screenshots + findings JSON: .local/ui-audit/<suite>/ (see docs/UI-AUDIT-A.md).
 */
const chrome = process.env.E2E_CHROME ?? '/opt/google/chrome/chrome';
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.audit\.ts$/,
  outputDir: resolve(ARTIFACT_DIR, 'audit-results'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 900_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    ...(existsSync(chrome) ? { launchOptions: { executablePath: chrome } } : { channel: 'chrome' }),
  },
});
