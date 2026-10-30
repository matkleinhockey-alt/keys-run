/**
 * The ocean ledger: where the water has been fished, as a deviation from the deterministic
 * baseline. Fish are a pure function of (world seed, chunk) on every client, so only DISTURBED
 * chunks have a row; a chunk with no row is pristine and the client uses the baseline unchanged.
 *
 *   GET  /ocean?cells=cx,cz;cx,cz;...   { cells: [{cx, cz, pressure, lastCaughtAt}] }   (public)
 *   POST /ocean/catch { cx, cz, amount? }   { cx, cz, pressure, lastCaughtAt }          (auth)
 *
 * The routes say as little as possible about what a row means: no thresholds, no size or rarity
 * policy. Recovery is a reader's calculation from `lastCaughtAt` and the clock, so the growth
 * curves can change without touching a row.
 *
 * The ONE exception is that a write decays before it adds, because it has to. A row stores a
 * single `pressure` as of a single `lastCaughtAt`, so adding to it without first ageing it would
 * sum catches from different weeks as though they were one session: a spot fished once a week
 * would climb to the cap and stay sour forever, which is the exact opposite of what the ledger
 * is for. The decay below is `pressureAfterCatch` from sim/ocean.ts, expressed in SQL so that the
 * read-decay-add-cap stays a single atomic statement, and it imports that module's own constants
 * so the two can never drift apart.
 *
 * Cells are the client's fish chunks (CHUNK_SIZE in apps/client/src/entities/fish/spawn.ts):
 * cx = floor(x / 64), cz = floor(z / 64). Like the wallet and the save, a catch is the client's
 * word; `amount` is capped so one request cannot be worth more than a plausible haul.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { WB } from '@keysrun/shared/world/depth';
import { PRESSURE_CAP, PRESSURE_HALF_LIFE_HOURS } from '@keysrun/shared/sim/ocean';
import { oceanCells } from '../db/schema.js';

/** The fish chunk edge in world units; must match CHUNK_SIZE in the client's fish/spawn.ts. */
const CHUNK_SIZE = 64;

/** The chunk range that overlaps the world box, so a coordinate outside it can never be fished. */
export const CELL_BOUNDS = {
  cx0: Math.floor(WB.x0 / CHUNK_SIZE), cx1: Math.floor(WB.x1 / CHUNK_SIZE),
  cz0: Math.floor(WB.z0 / CHUNK_SIZE), cz1: Math.floor(WB.z1 / CHUNK_SIZE),
};

/**
 * Most cells one GET may ask for. A client loading the area around the boat wants a square of
 * chunks (16 x 16 = 1024 world units a side is already beyond fish draw distance), so 256 covers
 * that in one trip; the cap also bounds the query size and keeps the URL near 2 KB, inside what
 * proxies accept. Larger than the area anyone needs, small enough that scraping the whole
 * world (~10,000 cells) takes dozens of requests, each rate limited.
 */
export const MAX_OCEAN_BATCH = 256;

/** Most pressure one catch may add: a generous bound on a single catch's worth, not a policy. */
export const MAX_CATCH_AMOUNT = 100;

const cellInt = (lo: number, hi: number) => z.number().int().min(lo).max(hi);
const Cx = cellInt(CELL_BOUNDS.cx0, CELL_BOUNDS.cx1);
const Cz = cellInt(CELL_BOUNDS.cz0, CELL_BOUNDS.cz1);

const CatchBody = z.object({
  cx: Cx,
  cz: Cz,
  amount: z.number().positive().max(MAX_CATCH_AMOUNT).default(1),
}).strict();

/** "cx,cz;cx,cz" -> unique in-world cells, or null if anything is malformed, out of world or too many. */
function parseCells(raw: unknown): { cx: number; cz: number }[] | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_OCEAN_BATCH * 16) return null;
  const parts = raw.split(';');
  if (parts.length > MAX_OCEAN_BATCH) return null;
  const seen = new Map<string, { cx: number; cz: number }>();
  for (const part of parts) {
    const m = /^(-?\d{1,6}),(-?\d{1,6})$/.exec(part);
    if (!m) return null;
    const cell = { cx: Number(m[1]), cz: Number(m[2]) };
    if (!Cx.safeParse(cell.cx).success || !Cz.safeParse(cell.cz).success) return null;
    seen.set(`${cell.cx},${cell.cz}`, cell);
  }
  return [...seen.values()];
}

export default async function oceanRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/ocean', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const cells = parseCells((request.query as Record<string, unknown>).cells);
    if (!cells) return reply.code(400).send({ error: 'bad_cells' });
    const rows = await fastify.db.select().from(oceanCells)
      .where(sql`(${oceanCells.cx}, ${oceanCells.cz}) IN (${sql.join(cells.map((c) => sql`(${c.cx}, ${c.cz})`), sql`, `)})`);
    return reply.send({
      cells: rows.map((r) => ({ cx: r.cx, cz: r.cz, pressure: r.pressure, lastCaughtAt: r.lastCaughtAt.toISOString() })),
    });
  });

  fastify.post(
    '/ocean/catch',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } }, preHandler: fastify.requireSession },
    async (request, reply) => {
      const body = CatchBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'bad_catch' });
      const { cx, cz, amount } = body.data;
      const now = new Date();
      // One atomic upsert: two anglers landing a fish in the same chunk both count, which a
      // read-then-write would lose.
      const [row] = await fastify.db.insert(oceanCells)
        .values({ cx, cz, pressure: Math.min(PRESSURE_CAP, amount), lastCaughtAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: [oceanCells.cx, oceanCells.cz],
          // pressureAfterCatch(stored, hours since stored): halve per PRESSURE_HALF_LIFE_HOURS,
          // add this catch, cap. GREATEST(0, ...) so a clock that stepped back counts as no
          // rest rather than negative rest, matching decayedPressure's own guard.
          set: {
            pressure: sql`LEAST(${PRESSURE_CAP}::double precision, ${oceanCells.pressure} * power(
              0.5,
              GREATEST(0, EXTRACT(EPOCH FROM (${now}::timestamptz - ${oceanCells.lastCaughtAt})) / 3600.0)
                / ${PRESSURE_HALF_LIFE_HOURS}::double precision
            ) + ${amount})`,
            lastCaughtAt: now,
            updatedAt: now,
          },
        })
        .returning();
      return reply.send({ cx, cz, pressure: row.pressure, lastCaughtAt: row.lastCaughtAt.toISOString() });
    },
  );
}
