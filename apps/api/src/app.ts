/**
 * Fastify app factory. Separate from src/index.ts (which loads env, opens a
 * real Pool and calls `.listen()`) so integration tests can build the app
 * against a test database and drive it with `.inject()` without binding a
 * port.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { Pool } from 'pg';
import type { Db } from './db/client.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import leaderboardRoutes from './routes/leaderboard.js';
import playersRoutes from './routes/players.js';
import catchesRoutes from './routes/catches.js';
import tagsRoutes from './routes/tags.js';
import estatesRoutes from './routes/estates.js';
import saveRoutes from './routes/save.js';
import healthRoutes from './routes/health.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    pgPool: Pool;
  }
}

export interface BuildAppOptions {
  db: Db;
  pool: Pool;
  corsOrigin: string[];
  logger?: boolean;
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: opts.logger ?? true });

  fastify.decorate('db', opts.db);
  fastify.decorate('pgPool', opts.pool);

  // @fastify/cors only allows GET, HEAD and POST by default, so every PUT was refused at the
  // preflight — which silently broke `PUT /estates/:id/build` (routes/estates.ts), the request
  // the client makes to build on a lot, and now also `PUT /save` (routes/save.ts), which is how
  // a signed-in player's game follows them between devices. Verified against production: the
  // preflight for a PUT came back `access-control-allow-methods: GET,HEAD,POST`, so the browser
  // never sent it.
  await fastify.register(cors, { origin: opts.corsOrigin, methods: ['GET', 'HEAD', 'POST', 'PUT'] });

  // global: false — this instance only enforces limits on routes that opt in
  // via `config.rateLimit` (the /auth/* routes). Every other route is
  // unaffected.
  await fastify.register(rateLimit, { global: false });

  await fastify.register(authPlugin);

  await fastify.register(healthRoutes);
  await fastify.register(authRoutes);
  await fastify.register(meRoutes);
  await fastify.register(leaderboardRoutes);
  await fastify.register(playersRoutes);
  await fastify.register(catchesRoutes);
  await fastify.register(tagsRoutes);
  await fastify.register(estatesRoutes);
  await fastify.register(saveRoutes);

  return fastify;
}
