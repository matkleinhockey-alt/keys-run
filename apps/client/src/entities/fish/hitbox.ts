/**
 * The spear hitbox of one live fish, built from the same numbers the renderer used this frame.
 *
 * Pure (no three.js): given a species' `CreatureVis`, a member's world transform and the swim
 * clock, return the capsule `sim/spear.ts`'s `stepSpear`/`assistAim` test against. Split out of
 * `index.ts`'s `pushSchoolTargets` so apps/client/test/fish-hitbox.test.ts can measure it against
 * the real rendered mesh — the previous inline version had never been checked against the art,
 * and measuring it found four things wrong with it:
 *
 *  1. **Length.** The capsule ran `±len/2` from the instance origin and THEN added the radius at
 *     both ends, so a capsule was `len + 2r` long. With the 0.22 m minimum radius that put the
 *     nose of a 0.42 m yellowtail 0.22 m in front of the drawn nose (shots in open water ahead of
 *     the fish scored hits) and the rear end 0.10 m past the peduncle. The body loft really does
 *     run z = -len/2 (nose) to ~+len/2 (peduncle); the tail fin continues beyond that, but a
 *     tail-fin graze is not a spear hit. Endpoints are now inset by the radius so the *rounded
 *     ends* land on nose and peduncle.
 *  2. **Swim-cycle deformation ignored.** The VAT (swim.ts/vat.ts) bends the body sideways with a
 *     quadratic-in-length lateral wave: zero at the nose, ~0.1*len peak at the tail fin
 *     (0.6*len on a marlin = 0.6 m). The capsule was a rigid straight line, so a fish mid-stroke
 *     had its rear third outside the hitbox and its hitbox sticking out the other side. The
 *     rear endpoint now follows the same wave (`lateralSwimAmp`, the very function
 *     `computeSwimProfile` bakes) at the current swim phase. A straight capsule cannot follow a
 *     curve, so the displacement is scaled by BEND_FIT (least-squares fit of a line from the nose
 *     to the displaced rear point against the quadratic wave: worst-case residual 0.03*len, far
 *     inside the radius).
 *  3. **Roll ignored.** The lateral axis is the instance's local X *after* roll, so a banking fish
 *     bends in a tilted plane. Computed from the full YXZ rotation.
 *  4. **Radius.** See `hitRadius`.
 */
import type { CreatureVis } from '@keysrun/shared/content/creatures';
import { lateralSwimAmp, swimAngSpeed, swimWavenumber, swimPhaseAt } from './swim.js';

export interface HitCapsule {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  radius: number;
}

/** Fraction of the rear endpoint's wave displacement the straight capsule follows — see (2). */
export const BEND_FIT = 0.57;
/** Where along the body (0 nose .. 1 tail-fin tip of the loft) the capsule's rear end sits. */
const REAR_U = 0.9;

/**
 * Capsule radius (m, before the member's own scale).
 *
 * Girth is the body's real half-height/half-width. A pure-girth hitbox is brutal on small
 * schooling fish (a 0.42 m yellowtail is 6 cm half-height) and an earlier pass fixed that with a
 * flat 0.22 m floor, which turned out to be 3-4x the fish — most of the "hits" on small fish were
 * clear misses on the art. The compromise is a floor that scales with length (a hand-sized fish
 * gets a hand-sized margin, a tuna does not get a barn door) plus a girth multiplier. Both numbers
 * are set from the measured hit/miss agreement in test/fish-hitbox.test.ts, not by feel.
 */
export const HIT_GIRTH_K = 1.4;
export const HIT_MIN_RADIUS_BASE = 0.05;
export const HIT_MIN_RADIUS_PER_LEN = 0.08;

export function hitRadius(V: CreatureVis): number {
  const Hh = V.h || V.len * 0.17, W = V.w || V.len * 0.16;
  const girth = Math.max(Hh, W) / 2;
  const floor = HIT_MIN_RADIUS_BASE + HIT_MIN_RADIUS_PER_LEN * V.len;
  return Math.max(floor, girth * HIT_GIRTH_K);
}

/** Member pose as render.ts submitted it. */
export interface HitPose {
  wx: number; wy: number; wz: number;
  yaw: number; pitch: number; roll: number;
  worldScale: number;
  swimPhase: number;
}

/** Capsule for `V` at `pose`, with the swim wave sampled at clock `swimT` (swim-clock.ts). */
export function fishCapsule(key: string, V: CreatureVis, pose: HitPose, swimT: number): HitCapsule {
  const sy = Math.sin(pose.yaw), cy = Math.cos(pose.yaw);
  const sp = Math.sin(pose.pitch), cp = Math.cos(pose.pitch);
  const sr = Math.sin(pose.roll), cr = Math.cos(pose.roll);
  // YXZ Euler (pool.ts pushInstance): R = Ry(yaw) Rx(pitch) Rz(roll).
  // local -Z (nose):
  const nx = -sy * cp, ny = sp, nz = -cy * cp;
  // local +X (the swim wave's displacement axis for every lateral swimmer):
  const lx = cr * cy + sr * sp * sy, ly = sr * cp, lz = -cr * sy + sr * sp * cy;

  const L = V.len * pose.worldScale;
  const half = L / 2;
  // Never wider than the fish is long: a tall, thin disc (lookdown, lionfish) would otherwise get
  // a sphere that pokes out ahead of the nose by the difference.
  const r = Math.min(hitRadius(V) * pose.worldScale, half);
  // inset by the radius so the rounded ends sit on the nose and the peduncle (see header, 1)
  const reach = Math.max(0, half - r);
  // nose end: lateral displacement of the wave is ~0 there (zero below u=0.28)
  const fx = pose.wx + nx * reach, fy = pose.wy + ny * reach, fz = pose.wz + nz * reach;

  const lateral = V.kind === 'fish' || V.kind === 'tuna' || V.kind === 'shark';
  let off = 0;
  if (lateral) {
    // Displacement is in geometry units (len-scaled by the instance's scale, applied after it).
    // Beat rate and wavelength are per-species now, so the capsule has to ask for this fish's
    // rather than assume the old global constants — otherwise the hitbox swims to a different
    // tune from the body the player can see.
    const theta = swimPhaseAt(swimT, swimAngSpeed(key, V), pose.swimPhase);
    off = lateralSwimAmp(key, V, REAR_U) * Math.sin(theta - REAR_U * swimWavenumber(key, V)) * pose.worldScale * BEND_FIT;
  }
  // rear end: tail-ward along the body axis, pushed sideways by the wave
  const bx = pose.wx - nx * reach + lx * off, by = pose.wy - ny * reach + ly * off, bz = pose.wz - nz * reach + lz * off;
  return { ax: fx, ay: fy, az: fz, bx, by, bz, radius: r };
}
