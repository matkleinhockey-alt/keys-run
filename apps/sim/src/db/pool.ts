/**
 * Raw `pg` pool — no drizzle/ORM here. `sim` only ever runs a handful of fixed, hand-reviewed
 * queries against two tables it does not own the schema of (`sessions`, `players` — both
 * defined and migrated by apps/api/src/db/schema.ts; `sim` never runs migrations). Keeping this
 * as plain parameterized SQL makes the "<500ms for 100 players" batched-upsert path in
 * lifecycle.ts easy to reason about, and keeps `sim`'s dependency graph minimal (no drizzle-kit,
 * no drizzle-orm) — see docs/ARCHITECTURE.md's deployment sizing note that `sim` buys CPU
 * headroom, not surface area.
 */
import { Pool } from 'pg';

export interface DbHandle {
  pool: Pool;
  close: () => Promise<void>;
}

export function createDb(connectionString: string): DbHandle {
  const pool = new Pool({ connectionString });
  return {
    pool,
    close: async () => {
      await pool.end();
    },
  };
}
