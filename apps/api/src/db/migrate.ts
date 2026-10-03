/**
 * Runs infra/migrations against DATABASE_URL (or $1, for test setup).
 * Usage: `pnpm db:migrate` (reads .env via the shell/dotenv), or
 * `tsx src/db/migrate.ts postgres://...` to target an explicit database
 * (used by the integration test bootstrap).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = path.resolve(HERE, '../../../../infra/migrations');

export async function runMigrations(connectionString: string): Promise<void> {
  const { db, close } = createDb(connectionString);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await close();
  }
}

async function main(): Promise<void> {
  const connectionString = process.argv[2] ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Usage: tsx src/db/migrate.ts [connectionString]  (or set DATABASE_URL)');
    process.exit(1);
  }
  await runMigrations(connectionString);
  console.log(`Migrations applied to ${connectionString.replace(/:[^:@/]+@/, ':***@')}`);
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
