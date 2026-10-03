/**
 * GET /health — 200 only if the PG pool can actually reach the database.
 * Used for Railway-style liveness/readiness checks.
 */
import type { FastifyInstance } from 'fastify';

export default async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/health', async (_request, reply) => {
    try {
      await fastify.pgPool.query('SELECT 1');
      return reply.code(200).send({ status: 'ok' });
    } catch (err) {
      fastify.log.error({ err }, 'health check: database unreachable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
