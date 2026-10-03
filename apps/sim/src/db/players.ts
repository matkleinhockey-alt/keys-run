/**
 * Reads/writes `players.resume` — the jsonb column apps/api/src/db/schema.ts reserved for
 * exactly this ("Phase 2+... the sim writes a resume blob here so a reconnecting player resumes
 * without a loading screen"). `sim` never touches any other column and never runs migrations.
 *
 * Reconnection semantics (docs/ARCHITECTURE.md "Reconnect-and-resume" + the Phase 2 task's
 * lifecycle checklist "Reconnect-and-resume via session token" / SIGTERM's "write resume
 * tokens"): this implementation reuses the *existing* 32-byte api-issued session token (the one
 * HELLO already carries) rather than minting a second, separately-expiring credential — a
 * reconnecting client simply presents the same session token again, and `sim` looks up
 * `players.resume` by the userId that token resolves to. "Write resume tokens" at SIGTERM is
 * satisfied by flushing every connected player's resume *state* (this `ResumeState`) before
 * exit, not by generating new secrets. See the Phase 2 handoff report for why: a distinct
 * short-lived resume-token system would need its own storage, and `players.resume` plus the
 * session token api already issues covers the same reconnect flow with no schema change.
 */
import type { Pool } from 'pg';

export interface ResumeState {
  x: number;
  z: number;
  /** Heading, radians. */
  h: number;
  speed: number;
  hullIndex: number;
  savedAtMs: number;
}

function isResumeState(v: unknown): v is ResumeState {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.x === 'number' &&
    typeof r.z === 'number' &&
    typeof r.h === 'number' &&
    typeof r.speed === 'number' &&
    typeof r.hullIndex === 'number' &&
    typeof r.savedAtMs === 'number'
  );
}

/** Returns the saved resume state for `userId`, or null for a brand-new player (no row, or `{}`). */
export async function loadResume(pool: Pool, userId: string): Promise<ResumeState | null> {
  const result = await pool.query<{ resume: unknown }>('SELECT resume FROM players WHERE user_id = $1 LIMIT 1', [userId]);
  const row = result.rows[0];
  if (!row || !isResumeState(row.resume)) return null;
  return row.resume;
}

export interface PlayerResumeRow {
  userId: string;
  resume: ResumeState;
}

/**
 * One batched upsert of every row — docs/ARCHITECTURE.md's graceful-shutdown step 4 ("one
 * batched upsert of all connected players (< 500 ms for 100)") and the 30 s autosave both call
 * this with their respective dirty set. No-ops on an empty array.
 */
export async function batchUpsertResume(pool: Pool, rows: readonly PlayerResumeRow[]): Promise<{ durationMs: number }> {
  const start = performance.now();
  if (rows.length === 0) return { durationMs: 0 };

  const values: string[] = [];
  const params: unknown[] = [];
  rows.forEach((row, i) => {
    const p1 = i * 2 + 1;
    const p2 = i * 2 + 2;
    values.push(`($${p1}, $${p2}::jsonb, now())`);
    params.push(row.userId, JSON.stringify(row.resume));
  });

  const sql = `
    INSERT INTO players (user_id, resume, updated_at)
    VALUES ${values.join(', ')}
    ON CONFLICT (user_id) DO UPDATE SET resume = excluded.resume, updated_at = excluded.updated_at
  `;
  await pool.query(sql, params);
  return { durationMs: performance.now() - start };
}
