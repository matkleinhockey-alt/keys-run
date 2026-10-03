/**
 * Autosave + graceful shutdown — docs/ARCHITECTURE.md's "Graceful shutdown (non-negotiable)"
 * sequence, implemented as plain async functions (no `process.exit` inside) so tests can call
 * `gracefulShutdown` directly and assert on the result/DB state without killing the test
 * process. `index.ts` is the only place that calls `process.exit(0)`, after awaiting this.
 *
 * Step numbering below matches the doc exactly:
 *   1. /health/ready -> 503            (readiness.ready = false)
 *   2. broadcast SERVER_RESTART{etaMs}
 *   3. resolve in-flight fights        N/A in Phase 2 — no fishing state machine exists yet
 *      (Phase 3). Left as an explicit no-op + comment rather than silently skipped.
 *   4. one batched upsert of all connected players
 *   5. write resume tokens
 *   6. close with code 4001, drain, exit(0)
 *
 * Steps 4 and 5 are *the same write* in this implementation — see db/players.ts's doc comment
 * for why "resume tokens" here means the saved `ResumeState` blob, not a second minted secret.
 */
import type { Pool } from 'pg';
import type { Server } from 'node:http';
import { encodeServerRestart } from './net/encode.js';
import { batchUpsertResume, type PlayerResumeRow, type ResumeState } from './db/players.js';
import type { World } from './world/world.js';
import type { WsTransport } from './net/ws-transport.js';
import type { ReadinessState } from './http.js';
import { SHUTDOWN_ETA_MS } from './constants.js';

function resumeStateFor(world: World, slot: number, nowMs: number): ResumeState {
  const e = world.entities;
  return { x: e.x[slot], z: e.z[slot], h: e.h[slot], speed: e.speed[slot], hullIndex: e.hullIndex[slot], savedAtMs: nowMs };
}

/** Every connected player, regardless of `dirty` — used by shutdown (save everyone, not just the dirty). */
export function collectAllResumeRows(world: World, nowMs = Date.now()): PlayerResumeRow[] {
  const rows: PlayerResumeRow[] = [];
  for (const slot of world.conns.keys()) {
    const conn = world.conns.get(slot);
    if (!conn) continue;
    rows.push({ userId: conn.userId, resume: resumeStateFor(world, slot, nowMs) });
  }
  return rows;
}

/** Only players with unsaved changes since the last autosave/shutdown — used by the 30s autosave. */
export function collectDirtyResumeRows(world: World, nowMs = Date.now()): PlayerResumeRow[] {
  const rows: PlayerResumeRow[] = [];
  for (const [slot, conn] of world.conns) {
    if (!conn.dirty) continue;
    rows.push({ userId: conn.userId, resume: resumeStateFor(world, slot, nowMs) });
    conn.dirty = false;
  }
  return rows;
}

export async function autosaveDirtyPlayers(world: World, pool: Pool, log: (msg: string) => void = () => {}): Promise<void> {
  const rows = collectDirtyResumeRows(world);
  if (rows.length === 0) return;
  const { durationMs } = await batchUpsertResume(pool, rows);
  log(`autosave: flushed ${rows.length} dirty player(s) in ${durationMs.toFixed(1)}ms`);
}

export interface LifecycleDeps {
  world: World;
  pool: Pool;
  wsTransport: WsTransport;
  httpServer: Server;
  readiness: ReadinessState;
  stopTickLoop: () => void;
  log?: (msg: string) => void;
}

export interface ShutdownResult {
  flushedPlayers: number;
  flushDurationMs: number;
}

export async function gracefulShutdown(deps: LifecycleDeps): Promise<ShutdownResult> {
  const log = deps.log ?? (() => {});
  log('graceful shutdown: starting');

  // 1. readiness -> 503
  deps.readiness.ready = false;

  // 2. broadcast SERVER_RESTART
  const scratch = new Uint8Array(8);
  const payload = encodeServerRestart(scratch, { etaMs: SHUTDOWN_ETA_MS });
  const payloadCopy = Buffer.from(payload);
  for (const ws of deps.wsTransport.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payloadCopy);
  }

  // 3. resolve in-flight fights — N/A, see module doc.

  // Stop ticking before snapshotting state, so what we save is stable and final.
  deps.stopTickLoop();

  // 4 + 5. one batched upsert of every connected player (doubles as "write resume tokens").
  const rows = collectAllResumeRows(deps.world);
  const { durationMs } = await batchUpsertResume(deps.pool, rows);
  log(`graceful shutdown: flushed ${rows.length} player(s) in ${durationMs.toFixed(1)}ms`);

  // 6. close with code 4001, drain.
  for (const ws of deps.wsTransport.clients) {
    try {
      ws.close(4001, 'server restart');
    } catch {
      // already closing/closed
    }
  }
  await deps.wsTransport.stop();
  await new Promise<void>((resolve) => deps.httpServer.close(() => resolve()));
  await deps.pool.end();

  return { flushedPlayers: rows.length, flushDurationMs: durationMs };
}
