/**
 * apps/api process entry point. Binds Fastify to 0.0.0.0:$PORT (Railway
 * requires 0.0.0.0, not localhost). This process never runs the 30 Hz sim
 * loop and never will — see docs/ARCHITECTURE.md's two-service split.
 */
import { loadEnv } from './env.js';
import { createDb } from './db/client.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const { db, pool, close } = createDb(env.DATABASE_URL);

  const fastify = await buildApp({ db, pool, corsOrigin: env.CORS_ORIGIN });

  const shutdown = async (signal: string): Promise<void> => {
    fastify.log.info({ signal }, 'shutting down');
    try {
      await fastify.close();
    } finally {
      await close();
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await fastify.listen({ port: env.PORT, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

void main();
