/**
 * Chum: a dead bird floating on the surface, and what it does to the fish underneath it.
 *
 * Shoot a seagull off the boat and it falls, hits the water, and lies there. That is a free meal
 * advertising itself, and in the Keys what turns up to a free meal on the surface is the toothy
 * end of the food chain — sharks, barracuda, big jacks. This module is the whole rule set for
 * that: how long a carcass stays interesting, how far it reaches, which species care, and how
 * hard it pulls them. Pure (no three.js, no DOM, no clock) so it can be unit tested
 * (packages/shared/test/chum.test.ts) and lifted onto the server with the rest of the fish
 * simulation later (docs/ARCHITECTURE.md phase 4/5).
 *
 * ## The shape of the attraction, and why it is the anchor-lean and not a chase
 *
 * `entities/fish/school.ts` already had the two halves of this. `nearestTrigger`/`Threat` REPEL a
 * school, and the `CURIOUS_*` block makes the patch a school mills over *lean* toward a
 * motionless diver. A carcass is the second one with the sign kept and the subject changed, and
 * that is deliberate: the alternative — steering the centroid straight at the carcass — gives you
 * fish that track the bait like missiles, which is both wrong and much less pleasant to watch.
 * Leaning the patch means they come in on a long arc and then mill and jostle over it, because
 * milling is what the anchor code already does once the patch is under them.
 *
 * So what this file produces is not a velocity or a heading. It is `chumPull`: a point and a
 * 0..1 weight, the exact same pair `CURIOUS_*` feeds into the anchor lerp.
 *
 * ## Numbers, and why these
 *
 * - **`CARCASS_LIFE_S` = 120.** Two minutes. Long enough to be a real event: at the edge of reach
 *   a shark takes ~70 s to work its way in (see reach, below), so the window has to be at least
 *   double that or the carcass goes cold before anything arrives and the whole feature reads as
 *   broken. Short enough that a player who empties a magazine into a flock does not permanently
 *   convert the reef into a shark pit — and `CARCASS_MAX` is the other half of that guard.
 * - **`CARCASS_REACH_M` = 55.** The first number written down was 90 m, on the theory that scent
 *   carries — and it does not survive the arithmetic. The lean is a soft pull working against the
 *   species' own wander, and the anchor block also drops a leaning school to 0.75 of cruise, so
 *   the effective closing speed is well under cruise: roughly 0.6-1 m/s for a 1.3 m/s bull shark.
 *   90 m is then a two-to-three minute swim, longer than the carcass lasts, so the far half of the
 *   reach would have been fish that never arrive. 55 m gets there inside the window from anywhere
 *   in range (measured in apps/client/test/school-chum.test.ts: 40 m closed to under 15 m in 90 s
 *   from every starting heading) while still being past the ~25-30 m you can see through, so
 *   something genuinely comes in "from out there".
 * - **`CARCASS_MILL_R` = 7.** The feeding ring. Tight on purpose: several schools converging on a
 *   7 m patch overlap and jostle, which is the "compete at the surface" read. A roomier ring and
 *   they orbit politely at separate radii.
 * - **`CARCASS_PULL` = 0.9.** Deliberately in the same place as school.ts's `CURIOUS_PULL` (0.92)
 *   — same mechanism, same ceiling, and under 1 for the same reason: a school whose anchor became
 *   the carcass *outright* would abandon its home patch and never get it back.
 * - **`CARCASS_MAX` = 4.** See `admitCarcass`.
 *
 * ## Why a carcass is NOT a fishing hotspot (considered, rejected)
 *
 * `game/fishing/spot.ts`'s `resolveCastSpot` already has a `hotspot` concept — a live bird-and-bait
 * frenzy — and a cast into one bites faster and rolls heavier (`sim/fight.ts`: entries under 2.5
 * in the zone table get x2.5, and `rollWeight` shifts up). Hanging a carcass off `nearHotspot`
 * would have been about four lines, and it was not done.
 *
 * Two reasons, and the second is the real one. First, `hs` is not just a catch modifier: it is
 * what makes the cast toast say "frenzy", what the minimap marks, and what the frenzy audio
 * follows (`world/frenzy.ts`, `entities/life/hotspots.ts`), so a dead gull would announce itself
 * as a boiling bait ball. Second and more important: the generic boost works on whatever zone
 * table the carcass happens to be floating over, so a cast at a shark frenzy would hand you a
 * hogfish. What a carcass draws is specific and visible — the shark circling it is right there —
 * and the only version worth having is one where what you hook is what you can see. That needs a
 * carcass-specific cast table and a toast of its own, which is rod-fishing work in
 * `game/fishing/**`, not this module's. Until then a carcass changes what swims past you and not
 * what bites, which is at least honest about itself.
 */

/**
 * One dead bird in the water. `id` is the caller's (the client's carcass renderer pairs its mesh
 * to this); `age`/`life` are seconds.
 */
export interface Carcass {
  id: string;
  x: number;
  z: number;
  /** Seconds since it hit the water. */
  age: number;
  /** Seconds it is worth anything in total. */
  life: number;
}

/** A point to lean a school's patch toward, and how hard (0..1). Same pair `CURIOUS_*` uses. */
export interface ChumPull {
  x: number;
  z: number;
  k: number;
}

/** Seconds a carcass draws fish. See this module's header for why two minutes. */
export const CARCASS_LIFE_S = 120;
/**
 * Seconds for a fresh carcass to reach full strength. Not realism (a splash is noticed instantly)
 * but a smoothing term: without it, a carcass hitting the water snaps every school in 55 m onto a
 * new anchor in one frame, which from the boat looks like the water twitching.
 */
export const CARCASS_BLOOM_S = 3;
/** How far a carcass at full potency is noticed, metres. */
export const CARCASS_REACH_M = 55;
/** Radius of the feeding ring a school mills in once it is on the carcass, metres. */
export const CARCASS_MILL_R = 7;
/** Hardest a carcass leans a school's patch, 0..1 of the way there. */
export const CARCASS_PULL = 0.9;
/** How many carcasses may be in the water at once. See `admitCarcass`. */
export const CARCASS_MAX = 4;

/**
 * The species that will come to a bird floating on the surface.
 *
 * This is an explicit list and not a rule derived from `CreatureVis`, because every derived rule
 * that was tried admitted something silly. "Apex class" (entities/fish/behavior.ts's `APEX_KEYS`,
 * which is about how little a fish fears a boat) lets in marlin and swordfish — bill-feeders that
 * stun live bait and live in 40 m+ of water. "`len` over a metre" lets in the tunas, which blitz
 * bait balls and do not pick at carrion, and the marine mammals. "`kind === 'shark'`" lets in the
 * nurse shark (a bottom suction feeder) and the whale shark (a filter feeder). Being attracted to
 * a dead bird is its own fact about a species, so it is written down as one.
 *
 * In, and why:
 *  - `bullshark`, `lemonshark`, `blacktip`, `tigershark`, `hammerhead` — the obvious answer. A
 *    tiger shark is the real-world champion of eating things that are not food.
 *  - `barracuda` — will investigate anything that flashes or flops on the surface.
 *  - `jackcrevalle`, `amberjack` — big jacks mob anything struggling on top.
 *  - `cobia` — scavenges along the surface behind rays and boats; famously curious.
 *  - `kingfish`, `wahoo` — the two mackerels big enough to take a whole bird.
 *  - `tarpon` — inhales prey whole and is documented doing it to birds. Also the one inshore
 *    entry big enough to make a shallow-water carcass worth shooting at.
 *  - `goliath` — a goliath grouper ambushing a pelican off the surface is a real and well filmed
 *    thing. It stays on the bottom here (`level: 'bottom'`), which is also true to life: it comes
 *    up for the hit and lives down there.
 *
 * Out, and why: the tunas (bait blitzers, not scavengers), `marlin`/`blackmarlin`/`sailfish`/
 * `swordfish` (bill-feeders, and far offshore), `nurse` (bottom suction feeder), `whaleshark`/
 * `giantmanta` (filter feeders), `sawfish` (benthic), every reef fish and baitfish — a bait school
 * must not queue up for a dead pelican — and every marine mammal: they are `catchable: false` in
 * content/creatures.ts, and a dolphin nosing a dead gull is a sadder scene than this game wants.
 */
export const SCAVENGER_KEYS: ReadonlySet<string> = new Set([
  'bullshark', 'lemonshark', 'blacktip', 'tigershark', 'hammerhead',
  'barracuda', 'jackcrevalle', 'amberjack', 'cobia', 'kingfish', 'wahoo', 'tarpon', 'goliath',
]);

/** Whether a species key comes to a carcass. */
export function isScavenger(key: string): boolean {
  return SCAVENGER_KEYS.has(key);
}

export function createCarcass(id: string, x: number, z: number, life: number = CARCASS_LIFE_S): Carcass {
  return { id, x, z, age: 0, life };
}

/**
 * House-style pure step (`step*(state, input, dt) -> state`). A carcass has no input — it just
 * ages — but the signature is kept so this reads like every other `step*` in sim/ and so a
 * current-drift input can be added later without changing call sites. (It is NOT drifted today:
 * the client's renderer nudges the mesh a few centimetres on the swell for looks, and the rules
 * treat the carcass as a fixed point, because a chum slick that walked 20 m downcurrent would
 * drag every school with it and the feature would read as fish chasing nothing.)
 */
export function stepCarcass(c: Carcass, _input: void, dt: number): Carcass {
  return { ...c, age: c.age + dt };
}

/** Past its life: nothing left to eat and nothing left to smell. */
export function carcassSpent(c: Carcass): boolean {
  return c.age >= c.life;
}

/**
 * How interesting a carcass is right now, 0..1 — blooms in over `CARCASS_BLOOM_S`, holds full for
 * the first half of its life, then fades linearly to nothing.
 *
 * The obvious shape — a straight linear fade over the whole life — is rejected because it never
 * gives the carcass a moment of being properly hot: the pull is already down to three-quarters by
 * the time anything has swum 30 m, so every arrival is half-hearted. A plateau then a fade gives
 * one clear minute of a real feed and one minute of it breaking up, which is the shape the scene
 * wants.
 */
export function carcassPotency(c: Carcass): number {
  if (c.age <= 0 || c.life <= 0) return 0;
  if (carcassSpent(c)) return 0;
  const bloom = Math.min(1, c.age / CARCASS_BLOOM_S);
  const half = c.life * 0.5;
  const fade = c.age <= half ? 1 : Math.max(0, 1 - (c.age - half) / (c.life - half));
  return bloom * fade;
}

/**
 * How far this carcass reaches right now, metres. Shrinks with potency but never to zero while it
 * exists: a picked-over carcass should still hold what is already on it rather than dropping
 * everything at once, which is why the floor is 45% of full reach rather than 0.
 */
export function carcassReach(c: Carcass): number {
  return CARCASS_REACH_M * (0.45 + 0.55 * carcassPotency(c));
}

/**
 * The strongest carcass pull acting on a school of `key` at `(cx, cz)`, or null.
 *
 * Several carcasses in the water do NOT add up, although summing or averaging them is the obvious
 * implementation. Two carcasses 40 m apart average to a point halfway between them where there is
 * no food at all, so schools would gather over empty water — and a sum of three could push the
 * combined weight past 1, which `stepSchool` would read as "this patch IS the carcass" and snap a
 * school onto it in a frame. Fish commit to one meal, so this picks the single best offer — best,
 * not nearest, because a fresh carcass at 40 m genuinely beats a spent one at 10. (The "pulled
 * toward the midpoint of two carcasses" case is pinned in packages/shared/test/chum.test.ts.)
 */
export function chumPull(
  key: string, cx: number, cz: number, carcasses: readonly Carcass[],
): ChumPull | null {
  if (!isScavenger(key)) return null;
  let best: ChumPull | null = null;
  for (const c of carcasses) {
    const p = carcassPotency(c);
    if (p <= 0) continue;
    const reach = carcassReach(c);
    const d = Math.hypot(c.x - cx, c.z - cz);
    if (d >= reach) continue;
    const k = CARCASS_PULL * (1 - d / reach) * p;
    if (k <= 0) continue;
    if (!best || k > best.k) best = { x: c.x, z: c.z, k };
  }
  return best;
}

/**
 * Add a carcass to the water, keeping at most `CARCASS_MAX` and dropping the oldest to make room.
 *
 * The cap is the counterweight to a two-minute life: the pistol holds twelve rounds and a flock
 * holds more gulls than that, so without it a good morning's shooting leaves a dozen permanent
 * attractors overlapping and every big fish in the chart converges on one spot. Four is enough
 * for "I put two in the water and the sharks could not decide" to happen, and the dropped one is
 * the oldest because that is the one with the least potency left to lose.
 */
export function admitCarcass(list: readonly Carcass[], c: Carcass): Carcass[] {
  const out = [...list, c];
  while (out.length > CARCASS_MAX) {
    let oldest = 0;
    for (let i = 1; i < out.length; i++) if (out[i].age > out[oldest].age) oldest = i;
    out.splice(oldest, 1);
  }
  return out;
}

/** Age every carcass and drop the spent ones. The list-level companion to `stepCarcass`. */
export function stepCarcasses(list: readonly Carcass[], _input: void, dt: number): Carcass[] {
  const out: Carcass[] = [];
  for (const c of list) {
    const next = stepCarcass(c, undefined, dt);
    if (!carcassSpent(next)) out.push(next);
  }
  return out;
}
