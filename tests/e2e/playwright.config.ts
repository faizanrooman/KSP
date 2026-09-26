import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ARTIFACT_DIR, BASE_URL } from './lib/env';

/**
 * E2E suite against the REAL stack of this checkout (API + worker + ai-worker + web, real Postgres/S3/FFmpeg/ONNX).
 * The stack is started separately (docs/E2E-TESTS.md). One worker: specs build on each other's data in file order
 * (00-setup enrols MFA, 02-upload creates evidence used by later specs).
 */
const chrome = process.env.E2E_CHROME ?? '/opt/google/chrome/chrome';

export default defineConfig({
  testDir: './specs',
  outputDir: resolve(ARTIFACT_DIR, 'results'),
  globalSetup: require.resolve('./global-setup'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: resolve(ARTIFACT_DIR, 'results.json') }], ['html', { open: 'never', outputFolder: resolve(ARTIFACT_DIR, 'report') }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chrome',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 900 },
        ...(existsSync(chrome) ? { launchOptions: { executablePath: chrome } } : { channel: 'chrome' }),
      },
    },
  ],
});
