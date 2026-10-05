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

const FLEE_PARAMS: Record<FleeClass, FleeParams> = {
  apex: { boatRadius: 4, boatSpeedRadius: 0.25, diverRadius: 3, spearRadius: 6, speedMul: 1.35 },
  glide: { boatRadius: 7, boatSpeedRadius: 0.4, diverRadius: 5, spearRadius: 8, speedMul: 1.15 },
  wary: { boatRadius: 9, boatSpeedRadius: 0.5, diverRadius: 7, spearRadius: 10, speedMul: 2.2 },
  skittish: { boatRadius: 6, boatSpeedRadius: 0.6, diverRadius: 9, spearRadius: 12, speedMul: 3.2 },
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
    const radius = th.kind === 'diver' ? p.diverRadius
      : th.kind === 'spear' ? p.spearRadius
      : (th.speed > 2 ? p.boatRadius + th.speed * p.boatSpeedRadius : p.boatRadius);
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
export const ACT_CD: Record<string, [number, number]> = { tail: [3, 9], roll: [4, 12], breathe: [8, 20], porpoise: [1.5, 4], bust: [2, 8], blow: [24, 65] };

/* ------------------------------------------------------------------------------------------ *
 * Dolphin bow-riding — real behavior: a pod notices a boat moving at a reasonable clip and peels
 * off to ride the pressure wave just off the bow. `school.ts`'s `stepSchool` consults these
 * constants/helper for `V.kind === 'dolphin'` schools only; every other species ignores a boat
 * threat exactly as before (nearestTrigger's normal flee check).
 * ------------------------------------------------------------------------------------------ */

/** Within this range of a pod's centroid, a moving boat is noticed and worth intercepting. */
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
