/**
 * GET /me — requires a session (fastify.requireSession). Returns the
 * authenticated user plus their `players` row (persistent non-auth player
 * state — currently just the Phase 2+ `resume` blob, see db/schema.ts).
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { users, players } from '../db/schema.js';

export default async function meRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/me', { preHandler: fastify.requireSession }, async (request, reply) => {
    const userId = request.userId as string;

    const [user] = await fastify.db
      .select({ id: users.id, email: users.email, displayName: users.displayName, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) {
      // Session pointed at a user row that no longer exists (shouldn't
      // happen — sessions cascade-delete with their user — but don't 500).
      return reply.code(401).send({ error: 'invalid or expired session' });
    }

    const [player] = await fastify.db.select({ resume: players.resume }).from(players).where(eq(players.userId, userId)).limit(1);

    return reply.send({ user, player: player ?? { resume: {} } });
  });
}
