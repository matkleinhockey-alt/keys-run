/**
 * apps/sim process entry point. Binds one `http.Server` on 0.0.0.0:$PORT serving /health,
 * /metrics and the WS upgrade (docs/ARCHITECTURE.md). All the actual wiring lives in app.ts
 * (buildSimApp) — this file only loads env, opens a real Pool, starts listening, and handles
 * process-level signals/exit, so tests and test/load.ts can build the same app without a
 * child process.
 */
import { createDb } from './db/pool.js';
import { loadEnv } from './env.js';
import { buildSimApp } from './app.js';
import { DT, SNAPSHOT_TICKS } from './constants.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const { pool } = createDb(env.DATABASE_URL);

  const app = buildSimApp({
    pool,
    maxPlayers: env.MAX_PLAYERS,
    autosaveIntervalMs: env.AUTOSAVE_INTERVAL_MS,
    log: (msg) => console.log(`[sim] ${msg}`),
  });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[sim] ${signal} received`);
    const result = await app.shutdown();
    console.log(`[sim] shutdown complete: flushed ${result.flushedPlayers} player(s) in ${result.flushDurationMs.toFixed(1)}ms`);
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  app.httpServer.listen(env.PORT, '0.0.0.0', () => {
    console.log(`[sim] listening on 0.0.0.0:${env.PORT} (tick=${1 / DT}Hz, snapshot=${1 / DT / SNAPSHOT_TICKS}Hz)`);
  });
}

void main();
