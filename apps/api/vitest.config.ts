import { defineConfig } from 'vitest/config';

// Integration tests run against real Postgres (TEST_DATABASE_URL) and share
// that one database across files, so files run one at a time rather than in
// parallel worker processes — correctness over speed for this suite.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/test/**/*.test.ts'],
    globalSetup: ['src/test/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
