import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['ksp-src'] },
  ssr: { resolve: { conditions: ['ksp-src'] } },
  test: {
    environment: 'node',
    // Rebuilds the ksp_test* database from migrations + seed (same as the API suite).
    globalSetup: ['../../apps/api/test/global-setup.ts'],
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: { NODE_ENV: 'test' },
  },
});
