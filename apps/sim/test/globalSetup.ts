/**
 * Vitest globalSetup — ensures TEST_DATABASE_URL exists and is migrated before lifecycle.test.ts
 * (the only suite here that touches real Postgres) runs. Mirrors apps/api/src/test/
 * globalSetup.ts's "create db if missing, then migrate" shape, reusing drizzle-orm's migrator
 * directly against infra/migrations (the same migrations apps/api owns and applies in
 * production) — `sim` itself never runs migrations at runtime; this is test-only
 * infrastructure, which is also why `drizzle-orm` is a devDependency here, not a dependency.
 */
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Side-effect import: loads the repo-root .env (if present) into process.env before we read
// TEST_DATABASE_URL/DATABASE_URL below.
import '../src/env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(HERE, '../../../infra/migrations');

function adminConnectionString(testUrl: string): string {
  const u = new URL(testUrl);
  u.pathname = '/postgres';
  return u.toString();
}

function dbNameFrom(testUrl: string): string {
  const name = new URL(testUrl).pathname.replace(/^\//, '');
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`refusing to use suspicious-looking test database name "${name}"`);
  }
  return name;
}

export default async function setup(): Promise<void> {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error('TEST_DATABASE_URL must be set (copy .env.example to .env at the repo root) to run apps/sim lifecycle tests');
  }
  if (testUrl === process.env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must not equal DATABASE_URL — lifecycle tests truncate tables');
  }

  const dbName = dbNameFrom(testUrl);
  const admin = new Pool({ connectionString: adminConnectionString(testUrl) });
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end();
  }

  const pool = new Pool({ connectionString: testUrl });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}
