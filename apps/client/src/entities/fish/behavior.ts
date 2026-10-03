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
/** Unhurried, majestic — move off steadily rather than bolting. */
const GLIDE_KEYS = new Set(['turtle', 'manatee', 'stingray', 'eagleray', 'dolphin']);

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
  /** Flee speed multiplier (legacy's `V.level==='bottom'?1.8:3.2`, now per behaviour class
   * instead of per depth-level). */
  speedMul: number;
}

const FLEE_PARAMS: Record<FleeClass, FleeParams> = {
  apex: { boatRadius: 4, boatSpeedRadius: 0.25, diverRadius: 3, speedMul: 1.35 },
  glide: { boatRadius: 7, boatSpeedRadius: 0.4, diverRadius: 5, speedMul: 1.15 },
  wary: { boatRadius: 9, boatSpeedRadius: 0.5, diverRadius: 7, speedMul: 2.2 },
  skittish: { boatRadius: 6, boatSpeedRadius: 0.6, diverRadius: 9, speedMul: 3.2 },
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
    const radius = th.kind === 'diver' ? p.diverRadius : (th.speed > 2 ? p.boatRadius + th.speed * p.boatSpeedRadius : p.boatRadius);
    if (d < radius && d < bestD) { best = th; bestD = d; }
  }
  return best;
}

/** legacy `ACT_DUR`/`ACT_CD` (index.html:2538-2539) — surface-act durations and cooldown ranges. */
export const ACT_DUR: Record<string, number> = { tail: 2.6, roll: 1.4, breathe: 3.5, porpoise: 1.2, bust: 0.7 };
export const ACT_CD: Record<string, [number, number]> = { tail: [3, 9], roll: [4, 12], breathe: [8, 20], porpoise: [1.5, 4], bust: [2, 8] };

/** legacy `angLerp` (index.html:2540). */
export function angLerp(a: number, b: number, t: number): number {
  const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * Math.min(1, t);
}
