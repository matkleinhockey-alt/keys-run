/**
 * Keys Run Estates — the shared land registry.
 *
 *   GET  /estates               every owned lot (bought or founding) with its build, and the party
 *   POST /estates/:id/buy       buy a lot that is for sale (auth)
 *   PUT  /estates/:id/build     save what stands on a lot you hold (auth)
 *
 * Parcels, prices and build options are fixed data/rules in packages/shared/src/content/estates.ts;
 * this table only says who holds what. A build is always run through `sanitizeBuild` before it is
 * stored, so whatever is in the table is something the client knows how to draw.
 *
 * Founding lots (`FOUNDING_HOLDERS`) are never for sale. They belong to the founder's email
 * (../founders.ts): the account signed in with it may build on them, under whatever display name
 * it chose, and is reported as their owner as soon as it exists; until it builds, the lot is
 * reported with its default build.
 *
 * Authority: the price is taken from the shared table, never from the client, but it is paid from
 * the client's own wallet (apps/client/src/game/economy/system.ts), which the server cannot see
 * yet. So this enforces one owner per lot and MAX_LOTS_PER_PLAYER, not affordability.
 *
 * The party: whoever is #1 on /leaderboard/overall throws it at their most valuable lot. Same
 * caveat as that board (routes/leaderboard.ts) — it is forgeable until catches are server-generated.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  FOUNDING_HOLDERS, MAX_LOTS_PER_PLAYER, defaultBuild, parcelById, partyLot, priceOf, sanitizeBuild,
  type Estate, type Party, type Registry,
} from '@keysrun/shared/content/estates';
import { estates, globalRecords, users } from '../db/schema.js';
import { FOUNDER_EMAILS, founderOf } from '../founders.js';

const Params = z.object({ id: z.string().min(1).max(80) });
const BuildBody = z.object({ build: z.record(z.string(), z.unknown()) });

const RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

export default async function estatesRoutes(fastify: FastifyInstance): Promise<void> {
  async function registry(): Promise<Registry> {
    const rows = await fastify.db
      .select({ parcelId: estates.parcelId, ownerName: users.displayName, founding: estates.founding, build: estates.build, boughtAt: estates.boughtAt })
      .from(estates)
      .innerJoin(users, eq(users.id, estates.ownerId));
    const out: Estate[] = [];
    for (const r of rows) {
      const p = parcelById(r.parcelId);
      if (p) out.push({ parcelId: r.parcelId, ownerName: r.ownerName, founding: r.founding, build: sanitizeBuild(r.build, p), boughtAt: r.boughtAt.toISOString() });
    }
    const held = new Set(out.map((e) => e.parcelId));
    // A founder who has signed up is named by their own display name, so their client sees the
    // lot as theirs; one who has not yet is named by the founder label.
    const founderRows = await fastify.db
      .select({ email: users.email, displayName: users.displayName })
      .from(users)
      .where(inArray(users.email, Object.values(FOUNDER_EMAILS)));
    const founderName = (label: string): string =>
      founderRows.find((u) => founderOf(u.email) === label)?.displayName ?? label;
    for (const [id, label] of Object.entries(FOUNDING_HOLDERS)) {
      const p = parcelById(id);
      if (p && !held.has(id)) out.push({ parcelId: id, ownerName: founderName(label), founding: true, build: defaultBuild(p), boughtAt: null });
    }

    let party: Party | null = null;
    const [top] = await fastify.db
      .select({ displayName: users.displayName, speciesKey: globalRecords.speciesKey, weightLb: globalRecords.weightLb })
      .from(globalRecords)
      .innerJoin(users, eq(users.id, globalRecords.userId))
      .orderBy(desc(globalRecords.weightLb))
      .limit(1);
    if (top) {
      const lot = partyLot(out.filter((e) => e.ownerName.toLowerCase() === top.displayName.toLowerCase()).map((e) => e.parcelId));
      if (lot) party = { parcelId: lot.id, displayName: top.displayName, speciesKey: top.speciesKey, weightLb: Number(top.weightLb) };
    }
    return { estates: out, party };
  }

  fastify.get('/estates', async (_request, reply) => reply.send(await registry()));

  fastify.post(
    '/estates/:id/buy',
    { config: { rateLimit: RATE_LIMIT }, preHandler: fastify.requireSession },
    async (request, reply) => {
      const params = Params.safeParse(request.params);
      const p = params.success ? parcelById(params.data.id) : undefined;
      if (!p) return reply.code(404).send({ error: 'no_such_lot' });
      if (FOUNDING_HOLDERS[p.id]) return reply.code(409).send({ error: 'founding_lot' });
      const userId = request.userId as string;

      const result = await fastify.db.transaction(async (tx) => {
        // Serialise one buyer's purchases so two quick buys can't both slip under the cap.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
        const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(estates)
          .where(and(eq(estates.ownerId, userId), eq(estates.founding, false)));
        if (n >= MAX_LOTS_PER_PLAYER) return 'limit' as const;
        const inserted = await tx.insert(estates)
          .values({ parcelId: p.id, ownerId: userId, price: priceOf(p), build: defaultBuild(p) })
          .onConflictDoNothing()
          .returning({ parcelId: estates.parcelId });
        return inserted.length ? 'ok' as const : 'taken' as const;
      });
      if (result === 'limit') return reply.code(409).send({ error: 'lot_limit', max: MAX_LOTS_PER_PLAYER });
      if (result === 'taken') return reply.code(409).send({ error: 'taken' });
      const reg = await registry();
      return reply.send({ estate: reg.estates.find((e) => e.parcelId === p.id), price: priceOf(p), party: reg.party });
    },
  );

  fastify.put(
    '/estates/:id/build',
    { config: { rateLimit: RATE_LIMIT }, preHandler: fastify.requireSession },
    async (request, reply) => {
      const params = Params.safeParse(request.params);
      const p = params.success ? parcelById(params.data.id) : undefined;
      if (!p) return reply.code(404).send({ error: 'no_such_lot' });
      const body = BuildBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'bad_build' });
      const userId = request.userId as string;
      const build = sanitizeBuild(body.data.build, p);

      const founder = FOUNDING_HOLDERS[p.id];
      if (founder) {
        const [me] = await fastify.db.select({ email: users.email }).from(users).where(eq(users.id, userId));
        if (!me || founderOf(me.email) !== founder) return reply.code(403).send({ error: 'not_yours' });
        await fastify.db.insert(estates)
          .values({ parcelId: p.id, ownerId: userId, price: 0, founding: true, build })
          .onConflictDoUpdate({ target: estates.parcelId, set: { build, updatedAt: new Date() } });
      } else {
        const updated = await fastify.db.update(estates)
          .set({ build, updatedAt: new Date() })
          .where(and(eq(estates.parcelId, p.id), eq(estates.ownerId, userId)))
          .returning({ parcelId: estates.parcelId });
        if (!updated.length) return reply.code(403).send({ error: 'not_yours' });
      }
      const reg = await registry();
      return reply.send({ estate: reg.estates.find((e) => e.parcelId === p.id), party: reg.party });
    },
  );
}
