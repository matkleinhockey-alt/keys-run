/**
 * /leaderboard/overall and /leaderboard/species.
 *
 * Both read from the maintained `global_records` / `species_records` tables
 * (see lib/records.ts) — never a scan or GROUP BY over `catches`. Those
 * tables are written only by `recordCatch`, and only for a non-suspicious
 * catch — see routes/catches.ts's doc comment for what "non-suspicious"
 * actually guarantees today (species-real + weight-plausible + rate-limited
 * + authenticated) and, just as importantly, what it does not (a modified
 * client can still claim a plausible weight with no real catch behind it —
 * that closes only once the sim owns the fight, ARCHITECTURE.md phase 3).
 */
import type { FastifyInstance } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { SPECIES } from '@keysrun/shared/content/species';
import { globalRecords, speciesRecords, users } from '../db/schema.js';

export default async function leaderboardRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/leaderboard/overall', async (_request, reply) => {
    const rows = await fastify.db
      .select({
        userId: globalRecords.userId,
        displayName: users.displayName,
        speciesKey: globalRecords.speciesKey,
        weightLb: globalRecords.weightLb,
        catchCount: globalRecords.catchCount,
      })
      .from(globalRecords)
      .innerJoin(users, eq(users.id, globalRecords.userId))
      .orderBy(desc(globalRecords.weightLb))
      .limit(100);

    return reply.send({
      rows: rows.map((r, i) => ({
        rank: i + 1,
        userId: r.userId,
        displayName: r.displayName,
        speciesKey: r.speciesKey,
        weightLb: Number(r.weightLb),
        catchCount: r.catchCount,
      })),
    });
  });

  fastify.get('/leaderboard/species', async (_request, reply) => {
    const rows = await fastify.db
      .select({
        speciesKey: speciesRecords.speciesKey,
        userId: speciesRecords.userId,
        displayName: users.displayName,
        weightLb: speciesRecords.weightLb,
        caughtAt: speciesRecords.caughtAt,
      })
      .from(speciesRecords)
      .innerJoin(users, eq(users.id, speciesRecords.userId));

    const bySpecies = new Map(rows.map((r) => [r.speciesKey, r]));

    // Always 40 rows (one per species in packages/shared's content table), in
    // SPECIES' own key order, even for species nobody has ever landed — a
    // missing row there isn't "no data", it's "nobody has caught one yet".
    const out = Object.keys(SPECIES).map((speciesKey) => {
      const row = bySpecies.get(speciesKey);
      return {
        speciesKey,
        top: row
          ? { userId: row.userId, displayName: row.displayName, weightLb: Number(row.weightLb), caughtAt: row.caughtAt }
          : null,
      };
    });

    return reply.send({ rows: out });
  });
}
