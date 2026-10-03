import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // packages/shared is pure Node/ESM — no jsdom, no browser globals. See docs/ARCHITECTURE.md.
  },
});
