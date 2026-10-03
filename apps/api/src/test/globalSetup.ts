/**
 * Vitest globalSetup — runs once, before any test file, in its own process.
 * Ensures the integration test database exists and is migrated to the
 * current schema. Individual test files truncate tables between tests (see
 * test/helpers.ts); this only handles "does the database itself exist".
 */
import { Pool } from 'pg';
// Side-effect import: loads the repo-root .env (if present) into
// process.env before we read TEST_DATABASE_URL / DATABASE_URL below.
import '../env.js';
import { runMigrations } from '../db/migrate.js';

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
    throw new Error(
      'TEST_DATABASE_URL must be set (copy .env.example to .env at the repo root) to run apps/api integration tests',
    );
  }
  if (testUrl === process.env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must not equal DATABASE_URL — integration tests truncate all tables');
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

  await runMigrations(testUrl);
}
