import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['ksp-src'] },
  ssr: { resolve: { conditions: ['ksp-src'] } },
  test: {
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: { NODE_ENV: 'test' },
  },
});
