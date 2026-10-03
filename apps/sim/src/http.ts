/**
 * Plain `node:http` server for /health and /metrics — deliberately not Fastify: this process's
 * only latency budget that matters is the 30 Hz tick, and these two routes are the entire HTTP
 * surface, so there's nothing a framework buys here that's worth its overhead or dependency
 * weight. The same `http.Server` is handed to `WsTransport` so WS upgrades and health checks
 * share one port (docs/ARCHITECTURE.md: "Binds 0.0.0.0:${PORT:-8081}").
 *
 * /health is 200 only if: readiness hasn't been flipped off by SIGTERM (lifecycle.ts), the tick
 * loop ran within HEALTH_MAX_TICK_AGE_MS, tick p99 < HEALTH_MAX_TICK_P99_MS, and the PG pool
 * answers a trivial query — all four, per docs/ARCHITECTURE.md's health criteria.
 */
import { createServer, type Server } from 'node:http';
import type { Pool } from 'pg';
import type { World } from './world/world.js';
import type { SimMetrics } from './metrics.js';
import { HEALTH_MAX_TICK_AGE_MS, HEALTH_MAX_TICK_P99_MS } from './constants.js';

export interface ReadinessState {
  ready: boolean;
}

export function createHttpServer(world: World, pool: Pool, metrics: SimMetrics, readiness: ReadinessState): Server {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      void handleHealth(world, pool, readiness, res);
      return;
    }
    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(metrics.snapshot()));
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

async function handleHealth(
  world: World,
  pool: Pool,
  readiness: ReadinessState,
  res: import('node:http').ServerResponse,
): Promise<void> {
  if (!readiness.ready) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'draining' }));
    return;
  }

  const tickAgeMs = world.lastTickTimestampMs === 0 ? 0 : Date.now() - world.lastTickTimestampMs;
  const tickFresh = world.totalTicks === 0 || tickAgeMs <= HEALTH_MAX_TICK_AGE_MS;
  const tickFast = world.tickPercentile(99) <= HEALTH_MAX_TICK_P99_MS;

  let dbLive = false;
  try {
    await pool.query('SELECT 1');
    dbLive = true;
  } catch {
    dbLive = false;
  }

  const healthy = tickFresh && tickFast && dbLive;
  res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: healthy ? 'ok' : 'unhealthy', tickFresh, tickFast, dbLive, tickAgeMs }));
}
