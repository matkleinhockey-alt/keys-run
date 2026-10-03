import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/globalSetup.ts'],
    // lifecycle.test.ts shares one real Postgres database across its cases — run test files
    // one at a time rather than in parallel workers, matching apps/api's convention.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
