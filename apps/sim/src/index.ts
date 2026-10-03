/**
 * apps/sim process entry point. Binds one `http.Server` on 0.0.0.0:$PORT serving /health,
 * /metrics and the WS upgrade (docs/ARCHITECTURE.md). Owns the fixed 30 Hz accumulator loop
 * ("while (acc >= DT && steps < 5) { step(DT); acc -= DT }", dropping backlog past 5 steps into
 * `world.simBehind` rather than death-spiraling) and the 15 Hz snapshot broadcast.
 */
import { createDb } from './db/pool.js';
import { loadEnv } from './env.js';
import { World, type Spawn } from './world/world.js';
import { createHttpServer, type ReadinessState } from './http.js';
import { WsTransport } from './net/ws-transport.js';
import { attachConnection } from './net/dispatch.js';
import { buildSnapshot } from './net/snapshot.js';
import { encodeSnapshot } from './net/encode.js';
import { SimMetrics } from './metrics.js';
import { autosaveDirtyPlayers, gracefulShutdown } from './lifecycle.js';
import { BOATS } from '@keysrun/shared/content/boats';
import { MARINAS } from '@keysrun/shared/world/depth';
import type { BoatHull } from '@keysrun/shared/sim/boat';
import { DT, MAX_STEPS_PER_FRAME, SNAPSHOT_TICKS } from './constants.js';

const HULL_TABLE: BoatHull[] = BOATS.map((b) => ({ len: b.len, beam: b.beam, top: b.top, accel: b.accel, turn: b.turn, draft: b.draft, cat: b.cat }));

function hullOf(index: number): BoatHull {
  return HULL_TABLE[index] ?? HULL_TABLE[0];
}

function defaultSpawn(): Spawn {
  const marina = MARINAS[0];
  // Small per-spawn jitter so simultaneous new players don't stack exactly on top of each other.
  const jitter = () => (Math.random() - 0.5) * 6;
  return { x: marina.ex + jitter(), z: marina.ez + jitter(), h: 0, speed: 0 };
}

function defaultHullIndex(): number {
  return 0; // robalo — Phase 2 has no boat-selection UI; see the handoff report.
}

const SNAPSHOT_SCRATCH = new Uint8Array(8192);
const candidateScratch: { entityId: number; distSq: number }[] = [];

async function main(): Promise<void> {
  const env = loadEnv();
  const { pool } = createDb(env.DATABASE_URL);

  const world = new World(env.MAX_PLAYERS, hullOf);
  const metrics = new SimMetrics(world);
  const readiness: ReadinessState = { ready: true };

  const httpServer = createHttpServer(world, pool, metrics, readiness);
  const wsTransport = new WsTransport(httpServer);

  wsTransport.onConnection((conn) => {
    attachConnection(conn, {
      world,
      pool,
      defaultSpawn,
      defaultHullIndex,
      onAuthRejected: () => metrics.recordAuthRejection(),
    });
  });

  let snapshotCounter = 0;
  function broadcastSnapshots(): void {
    for (const [, conn] of world.conns) {
      const msg = buildSnapshot({ tick: world.currentTick, conn, entities: world.entities, snapshotCounter, scratchCandidates: candidateScratch });
      const bytes = encodeSnapshot(SNAPSHOT_SCRATCH, msg);
      metrics.recordBytesSent(bytes.length);
      conn.send(bytes);
    }
    world.clearCorrectedFlags();
    snapshotCounter++;
  }

  // Fixed 30 Hz accumulator loop. Polled at a finer grain than DT so the real step boundary is
  // hit accurately; never runs more than MAX_STEPS_PER_FRAME steps per poll (see module doc).
  let acc = 0;
  let lastNowMs = performance.now();
  let tickCount = 0;
  const loopHandle = setInterval(() => {
    const nowMs = performance.now();
    acc += (nowMs - lastNowMs) / 1000;
    lastNowMs = nowMs;
    let steps = 0;
    while (acc >= DT && steps < MAX_STEPS_PER_FRAME) {
      world.tick(Date.now());
      acc -= DT;
      steps++;
      tickCount++;
      if (tickCount % SNAPSHOT_TICKS === 0) broadcastSnapshots();
    }
    if (acc >= DT) {
      world.simBehind++;
      acc = 0;
    }
  }, 5);

  const autosaveHandle = setInterval(() => {
    void autosaveDirtyPlayers(world, pool, (msg) => console.log(`[sim] ${msg}`));
  }, env.AUTOSAVE_INTERVAL_MS);

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[sim] ${signal} received`);
    clearInterval(autosaveHandle);
    const result = await gracefulShutdown({
      world,
      pool,
      wsTransport,
      httpServer,
      readiness,
      stopTickLoop: () => clearInterval(loopHandle),
      log: (msg) => console.log(`[sim] ${msg}`),
    });
    console.log(`[sim] shutdown complete: flushed ${result.flushedPlayers} player(s) in ${result.flushDurationMs.toFixed(1)}ms`);
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  httpServer.listen(env.PORT, '0.0.0.0', () => {
    console.log(`[sim] listening on 0.0.0.0:${env.PORT} (tick=${1 / DT}Hz, snapshot=${1 / DT / SNAPSHOT_TICKS}Hz)`);
  });
}

void main();
