/**
 * Catch-insertion and record-derivation helpers.
 *
 * recordCatch() is the ONLY way a row is ever written to `catches` in this
 * codebase. There is no HTTP endpoint that calls it — see
 * docs/ARCHITECTURE.md "The leaderboard is reachable only through
 * server-generated catch rows". In Phase 1 (no `sim` yet) it is called only
 * from db/seed.ts and from test fixtures that need leaderboard data to
 * assert against.
 */
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { catches, globalRecords, speciesRecords, players } from '../db/schema.js';

export interface CatchInput {
  userId: string;
  speciesKey: string;
  weightLb: number;
  caughtAt?: Date;
}

/**
 * Inserts one catch row and incrementally maintains `global_records` and
 * `species_records` so the leaderboard endpoints never scan `catches`.
 * Runs in a transaction: the catch row, the per-user overall-best upsert,
 * and the per-species-best upsert all commit together.
 */
export async function recordCatch(db: Db, input: CatchInput): Promise<{ catchId: string }> {
  const caughtAt = input.caughtAt ?? new Date();
  const weightStr = input.weightLb.toFixed(2);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(catches)
      .values({ userId: input.userId, speciesKey: input.speciesKey, weightLb: weightStr, caughtAt })
      .returning({ id: catches.id });
    const catchId = row.id;

    // Per-user overall best + running catch count.
    await tx
      .insert(globalRecords)
      .values({ userId: input.userId, catchId, speciesKey: input.speciesKey, weightLb: weightStr, catchCount: 1 })
      .onConflictDoUpdate({
        target: globalRecords.userId,
        set: {
          catchId: sql`CASE WHEN ${globalRecords.weightLb} < ${weightStr} THEN ${catchId} ELSE ${globalRecords.catchId} END`,
          speciesKey: sql`CASE WHEN ${globalRecords.weightLb} < ${weightStr} THEN ${input.speciesKey} ELSE ${globalRecords.speciesKey} END`,
          weightLb: sql`GREATEST(${globalRecords.weightLb}, ${weightStr})`,
          catchCount: sql`${globalRecords.catchCount} + 1`,
          updatedAt: sql`now()`,
        },
      });

    // Per-species best across all players.
    await tx
      .insert(speciesRecords)
      .values({ speciesKey: input.speciesKey, userId: input.userId, catchId, weightLb: weightStr, caughtAt })
      .onConflictDoUpdate({
        target: speciesRecords.speciesKey,
        set: {
          userId: sql`CASE WHEN ${speciesRecords.weightLb} < ${weightStr} THEN ${input.userId} ELSE ${speciesRecords.userId} END`,
          catchId: sql`CASE WHEN ${speciesRecords.weightLb} < ${weightStr} THEN ${catchId} ELSE ${speciesRecords.catchId} END`,
          weightLb: sql`GREATEST(${speciesRecords.weightLb}, ${weightStr})`,
          caughtAt: sql`CASE WHEN ${speciesRecords.weightLb} < ${weightStr} THEN ${caughtAt.toISOString()}::timestamptz ELSE ${speciesRecords.caughtAt} END`,
          updatedAt: sql`now()`,
        },
      });

    return { catchId };
  });
}

export interface PlayerRecords {
  best: { key: string; weight: number } | null;
  sp: Record<string, number>;
  count: number;
}

/**
 * The shape legacy's client already renders (LB.mine: {best, sp, count}) —
 * see legacy/index.html's `lbRecord`/`lbRows`. Derived on demand from
 * `catches` scoped to one user (bounded by that user's own catch count, and
 * backed by the catches(user_id, caught_at DESC) index), not from a
 * global/shared table.
 */
export async function getPlayerRecords(db: Db, userId: string): Promise<PlayerRecords> {
  const rows = await db
    .select({ speciesKey: catches.speciesKey, weightLb: catches.weightLb })
    .from(catches)
    .where(eq(catches.userId, userId));

  const sp: Record<string, number> = {};
  let best: { key: string; weight: number } | null = null;
  for (const row of rows) {
    const weight = Number(row.weightLb);
    if (!sp[row.speciesKey] || weight > sp[row.speciesKey]) sp[row.speciesKey] = weight;
    if (!best || weight > best.weight) best = { key: row.speciesKey, weight };
  }
  return { best, sp, count: rows.length };
}

/**
 * Whether a `players` row exists for this user — i.e. whether the account
 * has completed registration's player-row bootstrap. NOT whether they have
 * any catches (an account with zero catches is still a valid player).
 */
export async function playerExists(db: Db, userId: string): Promise<boolean> {
  const rows = await db.select({ userId: players.userId }).from(players).where(eq(players.userId, userId)).limit(1);
  return rows.length > 0;
}
