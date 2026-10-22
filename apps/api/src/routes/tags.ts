/**
 * Tag-and-release registry — the shared record of every tagged fish in the game.
 *
 *   GET  /tags/nearby?x=&z=   at-large tagged fish that could be on the line at (x, z) right now
 *   GET  /tags/:id            one tagged fish and its full life history
 *   POST /tags                tag a fish you just landed and release it (auth)
 *   POST /tags/:id/landed     report landing an already-tagged fish: released again or kept (auth)
 *
 * The growth/wander/cooldown rules live in packages/shared/src/sim/tagging.ts so the client's
 * offline registry runs the same ones. A tagged fish's current weight is never stored — it is
 * the last in-hand weight grown by the time since (`grownWeight`), computed on every read.
 *
 * Authority: same interim tradeoff as routes/catches.ts (read its doc comment). Tagging is a
 * client assertion, so POST /tags runs the same species/weight-range check and simply refuses an
 * implausible fish rather than putting it into everyone's water. POST /tags/:id/landed never takes
 * a weight from the client at all, and refuses a landing where the fish could not be (out of its
 * wander radius, still on its post-release cooldown, or already harvested).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, gte, inArray, lte, lt } from 'drizzle-orm';
import {
  DAY_MS,
  RECAPTURE_COOLDOWN_MS,
  grownWeight,
  tagCode,
  wanderRadiusM,
  type TagEvent,
  type TagEventKind,
  type TaggedFish,
} from '@keysrun/shared/sim/tagging';
import type { Db } from '../db/client.js';
import { tagEvents, taggedFish, users } from '../db/schema.js';
import { assessCatch } from '../lib/catch-validation.js';

const Coord = z.number().finite().min(-100000).max(100000);
const Zone = z.string().trim().min(1).max(64);

const TagBody = z.object({
  speciesKey: z.string().trim().min(1).max(64),
  weightLb: z.number().positive().finite().max(99999.99),
  x: Coord,
  z: Coord,
  zone: Zone,
});

const LandedBody = z.object({ x: Coord, z: Coord, zone: Zone, kept: z.boolean() });

const NearbyQuery = z.object({ x: z.coerce.number().finite(), z: z.coerce.number().finite() });

const Params = z.object({ id: z.string().uuid() });

/** Same per-route opt-in as routes/catches.ts — a tag write follows a landed fish, so the same
 * ceiling applies. */
const RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;

type FishRow = typeof taggedFish.$inferSelect;

function daysSince(at: Date, now: Date): number {
  return Math.max(0, (now.getTime() - at.getTime()) / DAY_MS);
}

function currentWeight(row: FishRow, now: Date): number {
  const w = Number(row.weightLb);
  return row.status === 'at_large' ? grownWeight(row.speciesKey, w, daysSince(row.lastSeenAt, now)) : w;
}

/** Could this at-large fish be the one on a line at (x, z) right now? */
function catchableAt(row: FishRow, x: number, z: number, now: Date): boolean {
  if (row.status !== 'at_large') return false;
  if (now.getTime() - row.lastSeenAt.getTime() < RECAPTURE_COOLDOWN_MS) return false;
  return Math.hypot(row.x - x, row.z - z) <= wanderRadiusM(daysSince(row.lastSeenAt, now));
}

async function loadEvents(db: Db, tagIds: string[]): Promise<Map<string, TagEvent[]>> {
  const out = new Map<string, TagEvent[]>();
  if (!tagIds.length) return out;
  const rows = await db
    .select({
      tagId: tagEvents.tagId,
      kind: tagEvents.kind,
      displayName: users.displayName,
      weightLb: tagEvents.weightLb,
      zone: tagEvents.zone,
      x: tagEvents.x,
      z: tagEvents.z,
      at: tagEvents.at,
    })
    .from(tagEvents)
    .innerJoin(users, eq(users.id, tagEvents.userId))
    .where(inArray(tagEvents.tagId, tagIds))
    .orderBy(asc(tagEvents.at));
  for (const r of rows) {
    const list = out.get(r.tagId) ?? [];
    list.push({
      kind: r.kind as TagEventKind,
      displayName: r.displayName,
      weightLb: Number(r.weightLb),
      zone: r.zone,
      x: r.x,
      z: r.z,
      at: r.at.toISOString(),
    });
    out.set(r.tagId, list);
  }
  return out;
}

function toTaggedFish(row: FishRow, events: TagEvent[], now: Date): TaggedFish {
  return {
    id: row.id,
    code: tagCode(row.tagNo),
    speciesKey: row.speciesKey,
    weightLb: currentWeight(row, now),
    x: row.x,
    z: row.z,
    status: row.status as TaggedFish['status'],
    lastSeenAt: row.lastSeenAt.toISOString(),
    events,
  };
}

async function loadTaggedFish(db: Db, id: string, now: Date): Promise<TaggedFish | null> {
  const [row] = await db.select().from(taggedFish).where(eq(taggedFish.id, id)).limit(1);
  if (!row) return null;
  const events = await loadEvents(db, [row.id]);
  return toTaggedFish(row, events.get(row.id) ?? [], now);
}

export default async function tagsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/tags/nearby', async (request, reply) => {
    const parsed = NearbyQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'x and z must be numbers' });
    const { x, z } = parsed.data;
    const now = new Date();
    const reach = wanderRadiusM(Infinity);
    // Coarse box in SQL (the largest a wander radius ever gets), exact per-fish radius below.
    const rows = await fastify.db
      .select()
      .from(taggedFish)
      .where(and(
        eq(taggedFish.status, 'at_large'),
        lt(taggedFish.lastSeenAt, new Date(now.getTime() - RECAPTURE_COOLDOWN_MS)),
        gte(taggedFish.x, x - reach), lte(taggedFish.x, x + reach),
        gte(taggedFish.z, z - reach), lte(taggedFish.z, z + reach),
      ))
      .limit(200);
    const near = rows.filter((r) => catchableAt(r, x, z, now)).slice(0, 50);
    const events = await loadEvents(fastify.db, near.map((r) => r.id));
    return reply.send({ fish: near.map((r) => toTaggedFish(r, events.get(r.id) ?? [], now)) });
  });

  fastify.get('/tags/:id', async (request, reply) => {
    const parsed = Params.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'id must be a uuid' });
    const fish = await loadTaggedFish(fastify.db, parsed.data.id, new Date());
    if (!fish) return reply.code(404).send({ error: 'tag not found' });
    return reply.send(fish);
  });

  fastify.post(
    '/tags',
    { config: { rateLimit: RATE_LIMIT }, preHandler: fastify.requireSession },
    async (request, reply) => {
      const parsed = TagBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid request body' });
      }
      const { speciesKey, weightLb, x, z, zone } = parsed.data;
      const userId = request.userId as string;

      const assessment = assessCatch(speciesKey, weightLb);
      if (!assessment) return reply.code(400).send({ error: `unknown species "${speciesKey}"` });
      // Unlike /catches (append-only ledger, flagged rows kept for audit), a tagged fish goes back
      // into everyone's water — an implausible one is refused outright.
      if (assessment.suspicion > 0) return reply.code(400).send({ error: 'weight out of range for species' });

      const weightStr = weightLb.toFixed(2);
      const now = new Date();
      const id = await fastify.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(taggedFish)
          .values({ speciesKey, weightLb: weightStr, x, z, taggedBy: userId, createdAt: now, lastSeenAt: now })
          .returning({ id: taggedFish.id });
        await tx.insert(tagEvents).values({ tagId: row.id, userId, kind: 'tagged', weightLb: weightStr, x, z, zone, at: now });
        return row.id;
      });

      return reply.code(201).send(await loadTaggedFish(fastify.db, id, now));
    },
  );

  fastify.post(
    '/tags/:id/landed',
    { config: { rateLimit: RATE_LIMIT }, preHandler: fastify.requireSession },
    async (request, reply) => {
      const params = Params.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'id must be a uuid' });
      const parsed = LandedBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid request body' });
      }
      const { x, z, zone, kept } = parsed.data;
      const userId = request.userId as string;
      const now = new Date();

      const outcome = await fastify.db.transaction(async (tx) => {
        // Row lock: two anglers reporting the same fish at once must not both harvest it.
        const [row] = await tx.select().from(taggedFish).where(eq(taggedFish.id, params.data.id)).for('update');
        if (!row) return { code: 404 as const, error: 'tag not found' };
        if (!catchableAt(row, x, z, now)) return { code: 409 as const, error: 'that tagged fish is not catchable here right now' };

        const weightStr = currentWeight(row, now).toFixed(2);
        await tx.insert(tagEvents).values({
          tagId: row.id, userId, kind: kept ? 'harvested' : 'released', weightLb: weightStr, x, z, zone, at: now,
        });
        await tx
          .update(taggedFish)
          .set({ weightLb: weightStr, x, z, lastSeenAt: now, status: kept ? 'harvested' : 'at_large' })
          .where(eq(taggedFish.id, row.id));
        return { code: 200 as const };
      });

      if (outcome.code !== 200) return reply.code(outcome.code).send({ error: outcome.error });
      return reply.send(await loadTaggedFish(fastify.db, params.data.id, now));
    },
  );
}
