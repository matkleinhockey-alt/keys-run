import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // boat-trajectory.test.ts is pure Node/ESM physics — no browser needed. Playwright (not
    // vitest) covers visual parity; see test/screenshots/ and docs/ARCHITECTURE.md.
    testTimeout: 30000,
  },
});
