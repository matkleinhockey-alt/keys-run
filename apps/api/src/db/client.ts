import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  pool: Pool;
  db: Db;
  close: () => Promise<void>;
}

/** Create a fresh pool + drizzle instance against `connectionString`. Callers own the lifecycle. */
export function createDb(connectionString: string): DbHandle {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return {
    pool,
    db,
    close: async () => {
      await pool.end();
    },
  };
}
