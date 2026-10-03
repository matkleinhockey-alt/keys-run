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

  await fastify.register(cors, { origin: opts.corsOrigin });

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

  return fastify;
}
