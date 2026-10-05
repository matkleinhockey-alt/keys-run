/**
 * Spearfishing: the shaft's flight physics, hit testing, and a speared fish's fight on the line.
 *
 * Net-new — spearfishing does not exist in legacy/index.html (docs/ARCHITECTURE.md's
 * "Spearfishing" section describes the intended design, not a port source). Pure, no three.js,
 * no DOM, no `Date.now()`: per the architecture doc, "the server spawns an authoritative spear
 * at the rewound origin/direction and integrates it forward at 25 m/s for ≤11 m, testing against
 * current fish positions each tick" — this module *is* that integrator, shaped so the exact same
 * `stepSpear` call the client uses for its own prediction is what the server later reruns from a
 * rewound origin with lag compensation (apps/sim, a different agent's scope — not wired here).
 *
 * `fire`/`stepSpear` take a target list of capsules and report the nearest hit, if any, this
 * step; they do not know about "the diver" or "aim plausibility" checks (docs/ARCHITECTURE.md's
 * envelope table) — those are server policy layered on top of this pure integrator, not part of
 * it.
 */

import { SPECIES } from '../content/species.js';
import { isCatchable } from '../content/creatures.js';
import { clamp } from '../internal/math.js';
import type { Rng } from '../rng/index.js';

/* ------------------------------------------------------------------------------------------ *
 * Constants (docs/ARCHITECTURE.md "Spearfishing" envelope table)
 * ------------------------------------------------------------------------------------------ */

export const SPEAR_SPEED = 25; // m/s
export const SPEAR_RANGE = 11; // m (projectile lifetime, not a hard raycast distance)
export const SPEAR_RELOAD = 2.5; // s, normal reload
export const SPEAR_RELOAD_FLOOR = 1.6; // s, hard anti-cheat floor — never fire faster than this

export interface Vec3 { x: number; y: number; z: number }

/* ------------------------------------------------------------------------------------------ *
 * The gun: loaded/reloading
 * ------------------------------------------------------------------------------------------ */

export interface GunState {
  /** Seconds remaining until the next shot is allowed. 0 = loaded. */
  reloadT: number;
}

export const createGun = (): GunState => ({ reloadT: 0 });

export const canFire = (gun: GunState): boolean => gun.reloadT <= 0;

/** Advances reload cooldown. Pure — returns a new `GunState`. */
export function stepReload(gun: GunState, dt: number): GunState {
  if (gun.reloadT <= 0) return gun;
  return { reloadT: Math.max(0, gun.reloadT - dt) };
}

/** Starts the reload timer after a shot. `reloadS` defaults to the normal 2.5 s; callers
 * enforcing the anti-cheat floor (`SPEAR_RELOAD_FLOOR`) pass that instead — never less. */
export function startReload(reloadS: number = SPEAR_RELOAD): GunState {
  return { reloadT: Math.max(SPEAR_RELOAD_FLOOR, reloadS) };
}

/* ------------------------------------------------------------------------------------------ *
 * The shaft in flight
 * ------------------------------------------------------------------------------------------ */

export interface ShotState {
  ox: number; oy: number; oz: number; // origin, world space
  dx: number; dy: number; dz: number; // unit direction
  /** Distance traveled from origin so far, meters. */
  dist: number;
  alive: boolean;
}

/** legacy-free, net-new: `fire` just normalizes direction and starts the shaft at `dist=0`. The
 * caller is responsible for gating this on `canFire`/consuming a `GunState` reload — this
 * function only knows about the projectile. */
export function fire(origin: Vec3, dir: Vec3): ShotState {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  return { ox: origin.x, oy: origin.y, oz: origin.z, dx: dir.x / len, dy: dir.y / len, dz: dir.z / len, dist: 0, alive: true };
}

export function shaftPosition(shot: ShotState, dist: number): Vec3 {
  return { x: shot.ox + shot.dx * dist, y: shot.oy + shot.dy * dist, z: shot.oz + shot.dz * dist };
}

/** A fish (or other spearable target), represented as a capsule swept between two points — the
 * same shape a lag-compensated server rewind would re-test against (a position-history segment
 * for that tick), and a reasonable hitbox for a swimming fish either way. */
export interface CapsuleTarget {
  id: string | number;
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  radius: number;
  /**
   * `false` means this target must never be hit — docs/ARCHITECTURE.md "Fish ownership — three
   * tiers": a species with `catchable: false` (marine mammals; content/creatures.ts) "has no
   * server representation at all". `stepSpear` below drops any such target from the hit test
   * entirely (it isn't merely "hit but then rejected" — the shaft behaves exactly as if the
   * target weren't there). Absent/`true` is an ordinary spearable fish. This module stays
   * domain-agnostic about *why* (see this file's header) — `capsuleFromSpecies` is the one place
   * that derives the flag from a species key, so callers don't need their own
   * `species === 'dolphin'` branch.
   */
  catchable?: boolean;
}

/** Builds a `CapsuleTarget` whose `catchable` flag is derived from the creature's own
 * `content/creatures.ts` VIS entry, so a caller assembling spear targets from real fish data
 * never has to special-case a species by name — see `CapsuleTarget.catchable`'s doc comment and
 * `isCatchable`. */
export function capsuleFromSpecies(
  id: string | number, key: string,
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number,
): CapsuleTarget {
  return { id, ax, ay, az, bx, by, bz, radius, catchable: isCatchable(key) };
}

export interface SpearHit {
  id: string | number;
  /** Distance from the shaft's origin at which the hit occurred, meters. */
  atDist: number;
  point: Vec3;
}

/**
 * Closest points between two line segments P1P2 and Q1Q2 (Ericson, "Real-Time Collision
 * Detection" §5.1.9). Returns the squared distance between the closest points and the
 * parametric `s` (0..1 along P1P2) at which it occurs — `s` is what `stepSpear` needs to know
 * *where along this step's travel* the hit happened.
 */
export function closestDistSqSegmentSegment(
  p1: Vec3, p2: Vec3, q1: Vec3, q2: Vec3,
): { distSq: number; s: number } {
  const d1x = p2.x - p1.x, d1y = p2.y - p1.y, d1z = p2.z - p1.z;
  const d2x = q2.x - q1.x, d2y = q2.y - q1.y, d2z = q2.z - q1.z;
  const rx = p1.x - q1.x, ry = p1.y - q1.y, rz = p1.z - q1.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  const EPS = 1e-12;
  let s: number, t: number;
  if (a <= EPS && e <= EPS) {
    s = 0; t = 0;
  } else if (a <= EPS) {
    s = 0; t = clamp(f / e, 0, 1);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS) {
      t = 0; s = clamp(-c / a, 0, 1);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      // Relative, not absolute, tolerance: `denom` is a difference of two products that scale
      // with `a*e` (squared segment lengths), so an absolute epsilon is too strict for long
      // segments and too loose for short ones — exactly the shape of bug this hit-tests against
      // every size of step (see test/spear.test.ts's "trajectory" describe block, which is what
      // surfaced this). Near-parallel (not just exactly parallel) segments fall into the same
      // s=0-then-correct-via-t-clamping branch below, which still finds the right point.
      s = denom > 1e-10 * a * e ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const cpx = p1.x + d1x * s, cpy = p1.y + d1y * s, cpz = p1.z + d1z * s;
  const cqx = q1.x + d2x * t, cqy = q1.y + d2y * t, cqz = q1.z + d2z * t;
  const dx = cpx - cqx, dy = cpy - cqy, dz = cpz - cqz;
  return { distSq: dx * dx + dy * dy + dz * dz, s };
}

/** Ray/capsule hit test over one shaft-travel segment: true if the segment ever comes within
 * `target.radius` of the target's swept segment, plus where (as `s` along the travel segment). */
export function segmentHitsCapsule(
  p1: Vec3, p2: Vec3, target: CapsuleTarget,
): { hit: boolean; s: number } {
  const { distSq, s } = closestDistSqSegmentSegment(
    p1, p2,
    { x: target.ax, y: target.ay, z: target.az },
    { x: target.bx, y: target.by, z: target.bz },
  );
  return { hit: distSq <= target.radius * target.radius, s };
}

/**
 * Advance the shaft by `dt` at `SPEAR_SPEED`, clamped to `SPEAR_RANGE`, and test the swept
 * segment against every target. Pure: returns a new `ShotState` plus the nearest hit this step
 * (by distance along the shaft), or `null`. Once `alive` is false (range exhausted or a hit was
 * already resolved), further calls are no-ops — the caller retires the shot.
 */
export function stepSpear(
  shot: ShotState, targets: readonly CapsuleTarget[], dt: number,
): { shot: ShotState; hit: SpearHit | null } {
  if (!shot.alive) return { shot, hit: null };
  const travel = Math.min(SPEAR_SPEED * dt, Math.max(0, SPEAR_RANGE - shot.dist));
  const p1 = shaftPosition(shot, shot.dist);
  const p2 = shaftPosition(shot, shot.dist + travel);

  let best: { target: CapsuleTarget; s: number } | null = null;
  for (const target of targets) {
    // `catchable: false` targets (marine mammals — see `CapsuleTarget.catchable`'s doc comment)
    // are excluded here, structurally, rather than hit-tested and then rejected: the shaft simply
    // cannot register a hit on one. See test/catchable.test.ts.
    if (target.catchable === false) continue;
    const { hit, s } = segmentHitsCapsule(p1, p2, target);
    if (hit && (!best || s < best.s)) best = { target, s };
  }

  const newDist = shot.dist + travel;
  if (best) {
    const atDist = shot.dist + travel * best.s;
    const point = shaftPosition(shot, atDist);
    return { shot: { ...shot, dist: atDist, alive: false }, hit: { id: best.target.id, atDist, point } };
  }
  const alive = newDist < SPEAR_RANGE - 1e-9;
  return { shot: { ...shot, dist: newDist, alive }, hit: null };
}

/* ------------------------------------------------------------------------------------------ *
 * A speared fish's fight — reuses `sim/fight.ts`'s tension/stamina shape where it fits, but a
 * fish on a spear tether behaves differently from one on a hook+line: there's no "running" far
 * (the shaft anchors it close), no jumping/sounding, and the failure mode is the shaft tearing
 * free under sustained peak tension rather than the hook shaking loose on slack line.
 * ------------------------------------------------------------------------------------------ */

export interface SpearFightParams {
  key: string;
  weight: number;
  str: number;
  /** Max tether length (float line + shaft), meters — much shorter than a hooked fight's
   * `maxLine`; this is a speared fish close against the gun, not one running out 200 m of reel. */
  tetherMax: number;
}

export function spearFightParamsFor(key: string, weight: number): SpearFightParams {
  const S = SPECIES[key];
  const sizeT = clamp((weight - S.min) / (S.max - S.min), 0, 1);
  return { key, weight, str: S.str * (0.8 + 0.55 * sizeT), tetherMax: 15 };
}

export type SpearFightOutcome = 'fighting' | 'landed' | 'tornFree';

export interface SpearFightState {
  x: number; z: number;
  tension: number;
  stam: number;
  thrashT: number;
  overT: number;
  dist: number;
  outcome: SpearFightOutcome;
}

/** Initial state right after a landed shot — the fish starts thrashing at the impact point. */
export function startSpearFight(fishX: number, fishZ: number): SpearFightState {
  return { x: fishX, z: fishZ, tension: 0.5, stam: 1, thrashT: 0, overT: 0, dist: 0, outcome: 'fighting' };
}

export interface SpearFightInput {
  /** Diver is hauling the line in (shortening the tether), analogous to a rod's reel. */
  hauling: boolean;
}

export interface SpearFightEnv {
  diverX: number;
  diverZ: number;
}

/**
 * One fixed step of a speared fish's struggle. Pure, deterministic given the same `rng` stream.
 * Haul with tension too high for too long and the shaft tears free (`tornFree`); haul the fish
 * to stamina 0 within tether range and it's landed.
 */
export function stepSpearFight(
  state: SpearFightState, input: SpearFightInput, params: SpearFightParams, env: SpearFightEnv, rng: Rng, dt: number,
): SpearFightState {
  if (state.outcome !== 'fighting') return state;
  const next: SpearFightState = { ...state };
  const { str } = params;

  next.thrashT -= dt;
  if (next.thrashT <= 0) {
    next.thrashT = 0.25 + rng() * 0.5 * (1.2 - 0.5 * next.stam);
    const a = rng() * Math.PI * 2, r = str * (1.5 + rng());
    next.x += Math.cos(a) * r * dt * 4;
    next.z += Math.sin(a) * r * dt * 4;
  }

  const dx0 = next.x - env.diverX, dz0 = next.z - env.diverZ;
  const dist0 = Math.hypot(dx0, dz0) || 1;
  // the tether is physical: the fish cannot thrash past tetherMax from the diver
  if (dist0 > params.tetherMax) {
    next.x = env.diverX + (dx0 / dist0) * params.tetherMax;
    next.z = env.diverZ + (dz0 / dist0) * params.tetherMax;
  }

  if (input.hauling) {
    next.tension = clamp(next.tension + (0.3 + str * 0.5) * dt, 0, 1.2);
  } else {
    next.tension += (0.25 - next.tension) * Math.min(1, dt * 1.5);
  }
  next.stam = Math.max(0, next.stam - dt * (0.12 + 0.18 * next.tension) / Math.sqrt(str));

  if (next.tension >= 1.1) {
    next.overT += dt;
    if (next.overT > 1.0) { next.outcome = 'tornFree'; return next; }
  } else next.overT = Math.max(0, next.overT - dt);

  if (input.hauling) {
    const dx = next.x - env.diverX, dz = next.z - env.diverZ, dist = Math.hypot(dx, dz) || 1;
    const r = 2 + str;
    next.x -= (dx / dist) * r * dt;
    next.z -= (dz / dist) * r * dt;
  }

  next.dist = Math.hypot(next.x - env.diverX, next.z - env.diverZ);
  if (next.stam <= 0 && next.dist < 1.2) { next.outcome = 'landed'; return next; }

  return next;
}
