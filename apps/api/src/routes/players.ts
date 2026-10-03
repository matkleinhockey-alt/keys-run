/**
 * GET /players/:id/records — `{best, sp{}, count}`, the exact shape the
 * legacy client's `LB.mine` already renders (see legacy/index.html's
 * `lbRecord`/`lbRows`). No auth required: this mirrors a public leaderboard
 * profile, same as /leaderboard/*.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { getPlayerRecords } from '../lib/records.js';

const Params = z.object({ id: z.string().uuid() });

export default async function playersRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/players/:id/records', async (request, reply) => {
    const parsed = Params.safeParse(request.params);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'id must be a uuid' });
    }
    const { id } = parsed.data;

    const [user] = await fastify.db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
    if (!user) {
      return reply.code(404).send({ error: 'player not found' });
    }

    const records = await getPlayerRecords(fastify.db, id);
    return reply.send(records);
  });
}
