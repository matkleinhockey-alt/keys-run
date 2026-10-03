import { defineConfig } from 'drizzle-kit';

// Migrations live in infra/migrations at the repo root (not apps/api), per
// the Phase 1 brief's repository layout — infra/ is shared ops surface, not
// something that belongs inside one app's directory.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: '../../infra/migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://keysrun:keysrun_dev_password@localhost:5433/keysrun',
  },
});
