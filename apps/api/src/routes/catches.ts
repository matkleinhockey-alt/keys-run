/**
 * POST /catches — an authenticated client reports a fish it just landed.
 *
 * HONESTY NOTE — read this before touching the authority model elsewhere.
 * docs/ARCHITECTURE.md is explicit: "species and weight travel server→client
 * only... there is no client→server 'I caught X' message anywhere in the
 * protocol" — full authority means the sim owns the entire cast/bite/fight/
 * land sequence and emits the CATCH itself (ARCHITECTURE.md phase 3,
 * "server-authoritative rod fishing"). This route is NOT that. A plain
 * authenticated POST is, structurally, a client assertion — nothing here
 * proves a cast or a fight ever happened.
 *
 * This is a deliberate interim step, taken because the alternative — a
 * leaderboard that is empty forever because nothing ever writes `catches` —
 * is worse, and because every write this route makes is append-only and
 * auditable, so the board can be rebuilt from scratch the day the sim takes
 * real ownership (phase 3) without a migration.
 *
 * What this route DOES guarantee:
 *   - authenticated: `fastify.requireSession` — no anonymous writes.
 *   - species is real: checked against packages/shared's SPECIES table. An
 *     unknown key is a hard 400 and nothing is written.
 *   - weight is plausible for that species: outside [min, max]
 *     (lib/catch-validation.ts's assessCatch) does NOT get silently trusted
 *     *or* silently dropped — the catch row is still written (append-only
 *     ledger), `suspicion` is set > 0, an `audit_flags` row is written in
 *     the same transaction, and — the part that actually protects the board
 *     — `global_records`/`species_records` are left untouched, so a flagged
 *     catch can never surface on `/leaderboard/*` or `/players/:id/records`
 *     (see lib/records.ts's `recordCatch`).
 *   - rate-limited: same per-IP `@fastify/rate-limit` mechanism as
 *     routes/auth.ts, so one account can't carpet-bomb the table.
 *
 * What this route does NOT guarantee:
 *   - that a cast, a fight, or any gameplay actually happened. A modified
 *     client can still claim any weight inside a real species' plausible
 *     range, as often as the rate limit allows, and it will land on the
 *     board exactly like a real catch. Closing that gap requires the sim to
 *     own the fight and emit CATCH server-side — out of scope here.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assessCatch } from '../lib/catch-validation.js';
import { recordCatch } from '../lib/records.js';

const CatchBody = z.object({
  speciesKey: z.string().trim().min(1).max(64),
  // numeric(7,2) in the DB tops out at 99999.99; this is just a sanity bound
  // at the envelope so an absurd value fails validation with a clear 400
  // instead of a Postgres overflow error. Per-species plausibility is a
  // separate, softer check below (assessCatch) — this is not that.
  weightLb: z.number().positive().finite().max(99999.99),
});

// Same per-route-opt-in pattern as routes/auth.ts's RATE_LIMIT (this fastify
// instance registers @fastify/rate-limit with `global: false` in app.ts, so
// only routes that pass `config.rateLimit` are limited at all). Keyed by IP
// by default, same as auth.ts — not by user, since that's what the existing
// pattern does; a per-user key would be a sharper tool but isn't necessary
// to stop the obvious abuse case (one client hammering the endpoint). 20/min
// is well above anything a real cast->fight->land cadence can produce (rod
// fishing's own minimum fight duration and 1-cast/0.4s cast limit, plus
// reload/travel time between spearfishing shots, keep a legitimate player
// well under 1 landed fish per few seconds) while still being a real ceiling
// on a scripted flood.
const RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;

export default async function catchesRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/catches',
    { config: { rateLimit: RATE_LIMIT }, preHandler: fastify.requireSession },
    async (request, reply) => {
      const parsed = CatchBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid request body' });
      }
      const { speciesKey, weightLb } = parsed.data;
      const userId = request.userId as string;

      const assessment = assessCatch(speciesKey, weightLb);
      if (!assessment) {
        return reply.code(400).send({ error: `unknown species "${speciesKey}"` });
      }
      const { species, suspicion } = assessment;
      const suspicious = suspicion > 0;

      const { catchId } = await recordCatch(fastify.db, {
        userId,
        speciesKey,
        weightLb,
        suspicion,
        flag: suspicious
          ? {
              reason: 'weight_out_of_range',
              details: { weightLb, min: species.min, max: species.max },
            }
          : undefined,
      });

      return reply.code(201).send({ catchId, suspicious });
    },
  );
}
