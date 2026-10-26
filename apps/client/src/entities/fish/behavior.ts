/**
 * Species-appropriate threat response, plus the small per-species constant tables legacy kept as
 * bare module-level objects (`ACT_DUR`, `ACT_CD`) and the shared angle-lerp helper `angLerp`.
 *
 * Legacy's flee check was one global rule for all 49 species (index.html:2547: `if((bs>2&&bd<14+
 * bs*.6)||bd<6){...g.flee=1.5;...}`, `sp*=V.level==='bottom'?1.8:3.2`) — a bonefish and a
 * barracuda startled identically. docs/ARCHITECTURE.md's task brief calls for the opposite ("a
 * barracuda doesn't flee like a yellowtail"): `fleeClassFor` buckets every species into one of
 * four behaviour classes and `FLEE_PARAMS` gives each class its own radius/speed response, for
 * both the boat (legacy's only threat) and a diver (new — smaller, quieter, but underwater and
 * close). No entity for "the diver" exists yet in this branch (see docs/ARCHITECTURE.md's
 * ownership split — `entities/diver/**` is a different agent's work), so `Threat.kind` is plumbed
 * all the way through but nothing currently hands this module a `'diver'` threat; whoever wires
 * the diver in later only needs to push one more entry onto the `threats` array passed into
 * `stepSchool` (school.ts) — no change needed here.
 */
import type { CreatureVis } from '@keysrun/shared/content/creatures';
import type { Threat } from './types.js';

export type FleeClass = 'apex' | 'glide' | 'wary' | 'skittish';

/** Apex/ambush predators and large pelagics — shrug off a boat, barely react to a diver. */
const APEX_KEYS = new Set([
  'barracuda', 'grouper', 'gag', 'redgrouper', 'goliath', 'marlin', 'blackmarlin', 'swordfish',
  'sailfish', 'wahoo', 'kingfish', 'amberjack', 'cobia', 'jackcrevalle', 'tripletail', 'lionfish',
]);
/** Unhurried, majestic — move off steadily rather than bolting. Whales (pilotwhale/humpback) are
 * "Slow, massive" per the task brief — even less hurried than a dolphin, see FLEE_PARAMS.glide. */
const GLIDE_KEYS = new Set(['turtle', 'manatee', 'stingray', 'eagleray', 'dolphin', 'pilotwhale', 'humpback']);

export function fleeClassFor(key: string, V: CreatureVis): FleeClass {
  if (GLIDE_KEYS.has(key)) return 'glide';
  if (V.kind === 'shark' || APEX_KEYS.has(key)) return 'apex';
  if (V.school[1] <= 2) return 'wary';
  return 'skittish';
}

export interface FleeParams {
  /** Flee trigger radius from a stationary boat (legacy's flat `6`). */
  boatRadius: number;
  /** Extra radius per m/s of boat speed (legacy's flat `.6`, gated on `bs>2`). */
  boatSpeedRadius: number;
  /** Flee trigger radius from a diver — closer than the boat (a diver is quiet and slow), but
   * underwater and therefore a direct, credible threat even to species that ignore the boat. */
  diverRadius: number;
  /** Flee trigger radius from a near-miss speargun shot (`Threat.kind: 'spear'`) — deliberately
   * larger than `diverRadius`: a shaft actually hissing past is a startle event closer to "a
   * predator struck and missed" than casual diver proximity, so even an `apex`-class fish reacts,
   * just over a smaller radius/with a smaller speed bump than a `skittish` schooling fish. */
  spearRadius: number;
  /** Flee speed multiplier (legacy's `V.level==='bottom'?1.8:3.2`, now per behaviour class
   * instead of per depth-level). */
  speedMul: number;
}

/**
 * How close any fish may come to a *stopped* boat — see `nearestTrigger`. Purely the hull's own
 * footprint: the longest boat is 13.1 m (Midnight Express 43 Open), so its volume reaches ~6.5 m
 * from centre, and this clears that with a little margin. Deliberately tight — anything larger
 * empties the water the player fishes and dives in.
 */
const HULL_CLEAR_RADIUS = 7.5;

/**
 * How close fish will come to a *calm* diver — the same idea as HULL_CLEAR_RADIUS, for the same
 * reason, and it was missing.
 *
 * `diverRadius` (3-9 m by class) was applied at every diver speed, so simply hanging in the water
 * cleared a bubble of baitfish wider than you could see through, and the reef read as empty from
 * the one viewpoint the whole underwater mode exists for. Real reef fish ignore a motionless
 * diver and will drift within touching distance; they bolt from one finning hard at them. That
 * distinction is what this restores — and it is the same one `nearestTrigger` already draws
 * between a boat under way and a boat at anchor.
 *
 * It is also what spearfishing needs: the gun's range is 11 m, so a 9 m permanent exclusion zone
 * left almost nothing legitimately in range.
 */
const DIVER_BODY_RADIUS = 1.6;
/** At or below this speed (m/s) a diver is drifting, and only `DIVER_BODY_RADIUS` applies. */
const DIVER_CALM_SPEED = 0.5;
/** At or above this, the species' full `diverRadius` applies — a hard-finning diver reads as a
 * predator closing. Between the two the radius ramps, so easing off visibly brings fish back in. */
const DIVER_SPOOK_SPEED = 2;

/**
 * `boatRadius` is the radius for a boat **under way** (`nearestTrigger` only applies it above
 * 2 kn; a stopped boat uses HULL_CLEAR_RADIUS instead).
 *
 * The ordering is behavioural: apex predators barely care about a hull, glides (turtles, rays,
 * the marine mammals) are unhurried but not stupid, and skittish baitfish scatter furthest. The
 * old table had skittish (6 m) *less* boat-shy than wary (9 m), which was backwards.
 */
const FLEE_PARAMS: Record<FleeClass, FleeParams> = {
  apex: { boatRadius: 9, boatSpeedRadius: 0.25, diverRadius: 3, spearRadius: 6, speedMul: 1.35 },
  glide: { boatRadius: 10, boatSpeedRadius: 0.4, diverRadius: 5, spearRadius: 8, speedMul: 1.15 },
  wary: { boatRadius: 12, boatSpeedRadius: 0.5, diverRadius: 7, spearRadius: 10, speedMul: 2.2 },
  skittish: { boatRadius: 14, boatSpeedRadius: 0.6, diverRadius: 9, spearRadius: 12, speedMul: 3.2 },
};

export function fleeParamsFor(cls: FleeClass): FleeParams {
  return FLEE_PARAMS[cls];
}

/** Closest threat that currently spooks this school, or null. Mirrors legacy's single
 * boat-distance check, generalised over `threats` and per-class radii. */
export function nearestTrigger(
  cx: number, cz: number, cls: FleeClass, threats: readonly Threat[],
): Threat | null {
  const p = fleeParamsFor(cls);
  let best: Threat | null = null, bestD = Infinity;
  for (const th of threats) {
    const d = Math.hypot(th.x - cx, th.z - cz);
    let radius: number;
    if (th.kind === 'spear') {
      radius = p.spearRadius;
    } else if (th.kind === 'diver') {
      // A diver hanging still is furniture; one finning hard is a predator closing — see
      // DIVER_BODY_RADIUS for why this distinction had to exist at all.
      const k = (th.speed - DIVER_CALM_SPEED) / (DIVER_SPOOK_SPEED - DIVER_CALM_SPEED);
      radius = DIVER_BODY_RADIUS + (p.diverRadius - DIVER_BODY_RADIUS) * Math.min(1, Math.max(0, k));
    } else {
      // A boat under way and a boat sitting still are two different things to a fish, and the
      // radius has to reflect that or one of the two reads wrong.
      //
      // Under way: the behavioural radius, grown with speed. Fish scatter well ahead of a moving
      // hull.
      //
      // Stopped: only the hull's own volume. Fish genuinely do gather under an anchored boat —
      // that is why anglers fish structure — so scattering them a full `boatRadius` leaves a dead
      // zone exactly where the player fishes and dives (measured: a diver entering the water at
      // the boat found zero spearable fish within 11 m). But they must not be *inside* the hull,
      // which is what the old always-on radius failed at from the other direction: it was 4-9 m
      // against hulls up to 13.1 m long, so fish swam through the boat in plain view.
      //
      // HULL_CLEAR_RADIUS is physical, not behavioural — an apex predator and a baitfish are
      // equally unable to occupy the same space as a hull — so it is not per-class.
      radius = th.speed > 2 ? p.boatRadius + th.speed * p.boatSpeedRadius : HULL_CLEAR_RADIUS;
    }
    if (d < radius && d < bestD) { best = th; bestD = d; }
  }
  return best;
}

/** legacy `ACT_DUR`/`ACT_CD` (index.html:2538-2539) — surface-act durations and cooldown ranges.
 * `blow` (whales — school.ts's stepMember) is the odd one out: the *duration* is a full gentle
 * surface-and-sound cycle (long enough for a blow near the start and a fluke-up near the end), and
 * the *cooldown* is deliberately much longer than any fish's — "long dive intervals" per the task
 * brief, the whole point of a whale sighting being a slow, occasional event rather than a constant
 * fish-like fidget. (Each member's very first act still fires within spawn.ts's 1-8s initial
 * `actTimer` window regardless of species, so a freshly-activated whale pod doesn't make a visiting
 * diver/boat wait a full cooldown just to see one blow.) */
export const ACT_DUR: Record<string, number> = { tail: 2.6, roll: 1.4, breathe: 3.5, porpoise: 1.2, bust: 0.7, blow: 4.5 };
// `tail` and `roll` are the two that put a fish through the surface where you can see it, and
// both fired often enough that a stretch of water always had something breaking on it. Rarer now,
// so a roll is something you notice rather than scenery. Deliberately unchanged: `breathe`
// (turtles and manatees have to come up), `porpoise` (a travelling dolphin really does porpoise
// every couple of seconds), `blow` (already a slow whale cycle) and `bust`, which is now gated on
// a school-wide frenzy in school.ts rather than on its own cooldown.
export const ACT_CD: Record<string, [number, number]> = { tail: [7, 18], roll: [10, 28], breathe: [8, 20], porpoise: [1.5, 4], bust: [2, 8], blow: [24, 65] };

/* ------------------------------------------------------------------------------------------ *
 * Dolphin bow-riding — real behavior: a pod notices a boat moving at a reasonable clip and peels
 * off to ride the pressure wave just off the bow. `school.ts`'s `stepSchool` consults these
 * constants/helper for `V.kind === 'dolphin'` schools only; every other species ignores a boat
 * threat exactly as before (nearestTrigger's normal flee check).
 * ------------------------------------------------------------------------------------------ */

/** Within this range of a pod's centroid, a moving boat is noticed and worth intercepting. */
/** Below this the threat is not really pursuing and a straight retreat is right. */
export const FLEE_SIDESTEP_MIN_SPEED = 0.9;
/** At this speed the break is fully across the threat's course rather than straight away. */
export const FLEE_SIDESTEP_FULL_SPEED = 3.2;

/**
 * Which way a spooked school breaks.
 *
 * Straight away from the threat's current position is right for something sitting still, and
 * wrong for something chasing. A boat holding trolling speed moves about as fast as a fleeing
 * school, so "directly away" is the one heading that keeps the school in front of the bow: it
 * runs ahead of the hull for as long as the boat holds course, which is what reads from the helm
 * as fish dancing around the boat rather than getting out of the way. Measured on a yellowtail
 * school with the boat at 3.6 m/s: it sat 16-17 m dead ahead, within 4 m of the boat's track,
 * for five seconds before it finally slipped off to one side.
 *
 * Real fish break across the bow and let the boat go by, so the faster the threat, the more of
 * the escape is turned across its course instead of along it. A school caught exactly ahead or
 * astern has no "across" to pick from, so it takes a side from its own position — deterministic,
 * so neighbouring schools do not all break the same way and the choice does not flicker.
 */
export function fleeHeadingFrom(cx: number, cz: number, th: Threat): number {
  const dx = cx - th.x, dz = cz - th.z;
  const d = Math.hypot(dx, dz) || 1e-6;
  let ax = dx / d, az = dz / d;
  if (th.heading !== undefined && th.speed > FLEE_SIDESTEP_MIN_SPEED) {
    // The threat's own course, in the same convention as everything else here.
    const cxv = -Math.sin(th.heading), czv = -Math.cos(th.heading);
    const along = ax * cxv + az * czv;
    let lx = ax - along * cxv, lz = az - along * czv;
    let ll = Math.hypot(lx, lz);
    if (ll < 1e-3) {
      // Dead ahead or dead astern: no across-course component to grow, so pick a beam.
      const side = (Math.floor(Math.abs(cx) * 0.37 + Math.abs(cz) * 0.11) % 2) === 0 ? 1 : -1;
      lx = -czv * side; lz = cxv * side; ll = 1;
    }
    lx /= ll; lz /= ll;
    const w = Math.min(1, (th.speed - FLEE_SIDESTEP_MIN_SPEED) / (FLEE_SIDESTEP_FULL_SPEED - FLEE_SIDESTEP_MIN_SPEED));
    ax = ax * (1 - w) + lx * w; az = az * (1 - w) + lz * w;
    const n = Math.hypot(ax, az) || 1e-6;
    ax /= n; az /= n;
  }
  // Heading whose forward vector (-sin h, -cos h) is the escape direction.
  return Math.atan2(-ax, -az);
}

export const BOW_RIDE_RADIUS = 70;
/** Below this speed there's no real pressure wave worth riding — a drifting/idling boat doesn't
 * attract a pod (and doesn't trigger the normal flee response either; dolphins are unbothered by
 * a slow boat). */
export const BOW_RIDE_MIN_SPEED = 1.8;
/** Above this speed the boat has outrun what a pod will bother chasing. */
export const BOW_RIDE_MAX_SPEED = 14;
/** Target point ahead of the bow, in the pressure wave, and to one side — meters. */
export const BOW_RIDE_AHEAD = 4.5;
export const BOW_RIDE_SIDE = 1.7;

/** Whether `V` (a school's species spec) is a dolphin — the only species that bow-rides. */
export function isBowRider(V: CreatureVis): boolean {
  return V.kind === 'dolphin';
}

/** The point a bow-riding pod steers its centroid toward, given the boat's position/heading and
 * which side of the bow this pod is riding (`side` ±1 — `school.ts` picks one deterministically
 * per school so multiple simultaneous pods spread across both sides instead of stacking). Boat
 * forward/right vectors use the exact convention `sim/boat.ts` itself uses for heading
 * (`fx=-sin(h), fz=-cos(h)`; see that file) — `heading` here is reconstructed from the boat's
 * frame-to-frame displacement (index.ts), since the `Threat` the boat is passed as doesn't
 * otherwise carry one. */
export function bowRideTarget(boatX: number, boatZ: number, heading: number, side: number): { x: number; z: number } {
  const fx = -Math.sin(heading), fz = -Math.cos(heading);
  const rx = Math.cos(heading), rz = -Math.sin(heading);
  return { x: boatX + fx * BOW_RIDE_AHEAD + rx * BOW_RIDE_SIDE * side, z: boatZ + fz * BOW_RIDE_AHEAD + rz * BOW_RIDE_SIDE * side };
}

/** legacy `angLerp` (index.html:2540). */
export function angLerp(a: number, b: number, t: number): number {
  const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * Math.min(1, t);
}
