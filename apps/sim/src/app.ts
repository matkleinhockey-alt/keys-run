/**
 * Builds a complete, runnable sim instance — http server, ws transport, World, the fixed-30Hz
 * tick loop and 15Hz broadcast, autosave — without binding a port or touching `process`. Split
 * out from index.ts (mirroring apps/api's app.ts/index.ts split) so tests and
 * test/load.ts can start/stop a real instance against a real (or test) Postgres without
 * spawning a child process.
 */
import type { Pool } from 'pg';
import { World, type Spawn } from './world/world.js';
import { createHttpServer, type ReadinessState } from './http.js';
import { WsTransport } from './net/ws-transport.js';
import { attachConnection } from './net/dispatch.js';
import { buildSnapshot } from './net/snapshot.js';
import { encodeSnapshot } from './net/encode.js';
import { SimMetrics } from './metrics.js';
import { autosaveDirtyPlayers, gracefulShutdown, type ShutdownResult } from './lifecycle.js';
import { BOATS } from '@keysrun/shared/content/boats';
import { MARINAS } from '@keysrun/shared/world/depth';
import type { BoatHull } from '@keysrun/shared/sim/boat';
import { DT, MAX_STEPS_PER_FRAME, SNAPSHOT_TICKS } from './constants.js';

const HULL_TABLE: BoatHull[] = BOATS.map((b) => ({ len: b.len, beam: b.beam, top: b.top, accel: b.accel, turn: b.turn, draft: b.draft, cat: b.cat }));

export function hullOf(index: number): BoatHull {
  return HULL_TABLE[index] ?? HULL_TABLE[0];
}

export function defaultSpawn(): Spawn {
  const marina = MARINAS[0];
  const jitter = () => (Math.random() - 0.5) * 6;
  return { x: marina.ex + jitter(), z: marina.ez + jitter(), h: 0, speed: 0 };
}

export function defaultHullIndex(): number {
  return 0; // robalo — Phase 2 has no boat-selection UI; see the handoff report.
}

export interface SimAppOptions {
  pool: Pool;
  maxPlayers: number;
  autosaveIntervalMs: number;
  log?: (msg: string) => void;
}

export interface SimApp {
  world: World;
  metrics: SimMetrics;
  readiness: ReadinessState;
  httpServer: ReturnType<typeof createHttpServer>;
  wsTransport: WsTransport;
  /** Stops the tick loop and autosave timers without doing the full graceful-shutdown sequence (test teardown). */
  stopLoops: () => void;
  shutdown: () => Promise<ShutdownResult>;
}

export function buildSimApp(opts: SimAppOptions): SimApp {
  const log = opts.log ?? (() => {});
  const world = new World(opts.maxPlayers, hullOf);
  const metrics = new SimMetrics(world);
  const readiness: ReadinessState = { ready: true };

  const httpServer = createHttpServer(world, opts.pool, metrics, readiness);
  const wsTransport = new WsTransport(httpServer);

  wsTransport.onConnection((conn) => {
    attachConnection(conn, {
      world,
      pool: opts.pool,
      defaultSpawn,
      defaultHullIndex,
      onAuthRejected: () => metrics.recordAuthRejection(),
    });
  });

  const snapshotScratch = new Uint8Array(8192);
  const candidateScratch: { entityId: number; distSq: number }[] = [];
  let snapshotCounter = 0;
  function broadcastSnapshots(): void {
    for (const [, conn] of world.conns) {
      const msg = buildSnapshot({ tick: world.currentTick, conn, entities: world.entities, snapshotCounter, scratchCandidates: candidateScratch });
      const bytes = encodeSnapshot(snapshotScratch, msg);
      metrics.recordBytesSent(bytes.length);
      conn.send(bytes);
    }
    world.clearCorrectedFlags();
    snapshotCounter++;
  }

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
    void autosaveDirtyPlayers(world, opts.pool, log);
  }, opts.autosaveIntervalMs);

  function stopLoops(): void {
    clearInterval(loopHandle);
    clearInterval(autosaveHandle);
  }

  async function shutdown(): Promise<ShutdownResult> {
    stopLoops();
    return gracefulShutdown({
      world,
      pool: opts.pool,
      wsTransport,
      httpServer,
      readiness,
      stopTickLoop: () => {}, // already stopped above
      log,
    });
  }

  return { world, metrics, readiness, httpServer, wsTransport, stopLoops, shutdown };
}
