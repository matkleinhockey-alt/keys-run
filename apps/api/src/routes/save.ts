/**
 * The signed-in player's game save, so money, boats, gear and the rest follow the account instead
 * of the browser.
 *
 *   GET /save   { data: {key: value} | null, updatedAt }   (auth)
 *   PUT /save   { data: {key: value} }                     (auth) — replaces the save
 *
 * `data` maps each game system's save key to its state, as JSON (apps/client/src/net/cloud-save.ts),
 * so the row reads like the game: data->'keysrun.economy.v1'->>'cash' is the wallet. Saves from the
 * first build hold JSON strings instead; the client reads both. The server keeps it as given: only
 * the key names, the count and the size are checked. Like the wallet it holds, it is the client's word — cash is not yet a
 * server-validated ledger (apps/client/src/game/economy/system.ts says when that changes).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { playerSaves } from '../db/schema.js';

/** The longest save accepted, in characters of JSON. */
export const MAX_SAVE_CHARS = 512 * 1024;

const SaveBody = z.object({
  data: z.record(z.string().regex(/^keysrun\.[a-z0-9.-]{1,60}$/), z.unknown()).refine((d) => Object.keys(d).length <= 32, 'too many keys'),
});

export default async function saveRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/save', { preHandler: fastify.requireSession }, async (request, reply) => {
    const [row] = await fastify.db.select().from(playerSaves).where(eq(playerSaves.userId, request.userId as string)).limit(1);
    return reply.send(row ? { data: row.data, updatedAt: row.updatedAt.toISOString() } : { data: null, updatedAt: null });
  });

  fastify.put(
    '/save',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } }, preHandler: fastify.requireSession, bodyLimit: MAX_SAVE_CHARS * 2 },
    async (request, reply) => {
      const body = SaveBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'bad_save' });
      const size = JSON.stringify(body.data.data).length;
      if (size > MAX_SAVE_CHARS) return reply.code(413).send({ error: 'save_too_large' });
      const now = new Date();
      await fastify.db.insert(playerSaves)
        .values({ userId: request.userId as string, data: body.data.data, updatedAt: now })
        .onConflictDoUpdate({ target: playerSaves.userId, set: { data: body.data.data, updatedAt: now } });
      return reply.send({ updatedAt: now.toISOString() });
    },
  );
}
