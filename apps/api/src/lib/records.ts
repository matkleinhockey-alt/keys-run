/**
 * Catch-insertion and record-derivation helpers.
 *
 * recordCatch() is the ONLY way a row is ever written to `catches` in this
 * codebase. Historically (Phase 1, no `sim` yet) it was called only from
 * db/seed.ts and test fixtures — see docs/ARCHITECTURE.md "The leaderboard
 * is reachable only through server-generated catch rows".
 *
 * routes/catches.ts now also calls this, from an authenticated client POST.
 * Read that route's doc comment for the honesty tradeoff that introduces —
 * this file stays agnostic to who's calling it and just enforces one
 * invariant: a `suspicion > 0` catch is written (the ledger is append-only)
 * but never allowed to move `global_records`/`species_records`, so a flagged
 * catch can never reach the public board.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { catches, globalRecords, speciesRecords, players, auditFlags } from '../db/schema.js';

export interface CatchInput {
  userId: string;
  speciesKey: string;
  weightLb: number;
  caughtAt?: Date;
  /**
   * >0 marks this catch suspicious (see routes/catches.ts's `assessCatch`).
   * Defaults to 0 (trusted) — every existing caller (db/seed.ts, tests)
   * passes no value and gets the exact pre-existing behaviour.
   */
  suspicion?: number;
  /** Written to `audit_flags` in the same transaction, only when `suspicion` > 0. */
  flag?: { reason: string; details?: Record<string, unknown> };
}

/**
 * Inserts one catch row and, unless it is flagged suspicious, incrementally
 * maintains `global_records` and `species_records` so the leaderboard
 * endpoints never scan `catches`. Everything — the catch row, the optional
 * `audit_flags` row, and the per-user/per-species upserts — commits in one
 * transaction.
 */
export async function recordCatch(db: Db, input: CatchInput): Promise<{ catchId: string; suspicious: boolean }> {
  const caughtAt = input.caughtAt ?? new Date();
  const weightStr = input.weightLb.toFixed(2);
  const suspicion = input.suspicion ?? 0;
  const suspicious = suspicion > 0;

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(catches)
      .values({ userId: input.userId, speciesKey: input.speciesKey, weightLb: weightStr, caughtAt, suspicion })
      .returning({ id: catches.id });
    const catchId = row.id;

    if (suspicious && input.flag) {
      await tx.insert(auditFlags).values({
        userId: input.userId,
        catchId,
        reason: input.flag.reason,
        details: input.flag.details ?? {},
      });
    }

    if (suspicious) {
      // Off the board: a flagged catch stays in the append-only ledger
      // (auditable, and rebuildable if policy changes) but never touches
      // the denormalised record tables the leaderboard actually reads.
      return { catchId, suspicious };
    }

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

    return { catchId, suspicious };
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
 *
 * Excludes `suspicion > 0` rows — same "keep it off the board" rule as the
 * global/species leaderboards (see routes/catches.ts), applied here too
 * since this is still a player-facing record, not an internal audit view.
 */
export async function getPlayerRecords(db: Db, userId: string): Promise<PlayerRecords> {
  const rows = await db
    .select({ speciesKey: catches.speciesKey, weightLb: catches.weightLb })
    .from(catches)
    .where(and(eq(catches.userId, userId), eq(catches.suspicion, 0)));

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
