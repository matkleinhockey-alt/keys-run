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

export const SPEAR_SPEED = 25; // m/s, muzzle speed
export const SPEAR_RANGE = 11; // m (projectile lifetime, not a hard raycast distance)
export const SPEAR_RELOAD = 2.5; // s, normal reload
export const SPEAR_RELOAD_FLOOR = 1.6; // s, hard anti-cheat floor — never fire faster than this

/**
 * Water drag on the shaft, expressed as a time constant for `dv/dt = -SPEAR_DRAG_K * v`
 * (exponential velocity decay — the standard first-order drag approximation). Chosen so the
 * shaft retains 60% of muzzle speed at `SPEAR_RANGE`: real water drag on a weighted spear shaft
 * over 11 m is a genuine effect but a mild one, not a shot that visibly stalls.
 *
 * The reason this is a *time* constant rather than a distance one: integrating `dv/dt=-k*v`
 * closed-form gives `v(t) = v0*exp(-k*t)` and `dist(t) = (v0/k)*(1-exp(-k*t))` — both pure
 * functions of elapsed flight time alone, so `distAtFlightTime` below reproduces the exact same
 * answer whether the caller asks for it in one big step or many tiny ones. That determinism
 * property (see test/spear.test.ts's "trajectory" describe block) is what the server's rewind-
 * and-reintegrate plan (docs/ARCHITECTURE.md "Spearfishing") depends on, and it's easy to lose by
 * accident with a naive per-step `v -= drag*dt` Euler integration (whose answer *does* depend on
 * step size). Composing `v(t)` and `dist(t)` algebraically also happens to collapse to a plain
 * linear speed-vs-distance relationship (`shaftSpeedAtDist` below) — a nice closed-form bonus,
 * not a separate model.
 */
export const SPEAR_DRAG_K = (0.4 * SPEAR_SPEED) / SPEAR_RANGE; // ≈0.909 / s

export interface Vec3 { x: number; y: number; z: number }

/** Closed-form distance traveled after `t` seconds of flight from the muzzle — see
 * `SPEAR_DRAG_K`'s doc comment for why this must be evaluated from cumulative elapsed time, never
 * accumulated step-by-step. Not range-clamped; callers clamp to `SPEAR_RANGE` themselves (`stepSpear`
 * does). */
export function distAtFlightTime(t: number): number {
  return (SPEAR_SPEED / SPEAR_DRAG_K) * (1 - Math.exp(-SPEAR_DRAG_K * t));
}

/**
 * Inverse of `distAtFlightTime`: seconds of flight to cover `dist` metres. Closed form — invert
 * `d = (v/k)(1 - e^-kt)` to `t = -ln(1 - dk/v)/k`.
 *
 * Used by `assistAim` to lead a moving target by the shaft's real time of flight. The log's
 * argument goes non-positive at the shaft's asymptotic maximum range (`v/k`, ~27.5 m — well past
 * `SPEAR_RANGE`), so it is clamped to keep this finite for any input a caller can produce.
 */
export function timeToDistance(dist: number): number {
  const maxD = SPEAR_SPEED / SPEAR_DRAG_K;
  const frac = clamp(dist / maxD, 0, 0.999);
  return -Math.log(1 - frac) / SPEAR_DRAG_K;
}

/** Instantaneous shaft speed after traveling `dist` meters from the muzzle. Linear in distance —
 * the algebraic consequence of `SPEAR_DRAG_K`'s exponential-in-time decay (substitute `t` out of
 * `v(t)` and `dist(t)`; see that constant's doc comment) — clamped at 0 defensively, though
 * `SPEAR_RANGE`'s hard cutoff means a real shaft never travels far enough to reach it. */
export function shaftSpeedAtDist(dist: number): number {
  return Math.max(0, SPEAR_SPEED - SPEAR_DRAG_K * dist);
}

/**
 * Probability a geometrically-registered hit actually *holds* (the tip penetrates and the shaft
 * stays anchored) rather than glancing off a fish too weakly struck to seat — docs/ARCHITECTURE.md's
 * spearfishing brief's "a shot at the edge of range should be unreliable rather than binary."
 * Below ~25% of muzzle speed (a shot that's traveled most of the way to a far graze) there's
 * essentially no chance; it ramps to a 0.95 cap at full muzzle speed — even a point-blank hit
 * isn't a certainty, same spirit as a hooked fish's line-break chance never being exactly 0 or 1.
 * Pure function of impact speed; callers decide how to roll it (see `stepSpear`'s optional `rng`).
 */
export function holdChance(impactSpeed: number): number {
  const frac = clamp(impactSpeed / SPEAR_SPEED, 0, 1);
  return clamp((frac - 0.25) / 0.6, 0, 1) * 0.95;
}

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
  /** Distance traveled from origin so far, meters — derived each step from `t` via
   * `distAtFlightTime`, not accumulated, so it stays exact regardless of step size. */
  dist: number;
  /** Elapsed flight time, seconds — the real state variable under water drag; `dist` is a cached
   * convenience derived from it. */
  t: number;
  alive: boolean;
}

/** legacy-free, net-new: `fire` just normalizes direction and starts the shaft at `dist=0`. The
 * caller is responsible for gating this on `canFire`/consuming a `GunState` reload — this
 * function only knows about the projectile. */
export function fire(origin: Vec3, dir: Vec3): ShotState {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  return { ox: origin.x, oy: origin.y, oz: origin.z, dx: dir.x / len, dy: dir.y / len, dz: dir.z / len, dist: 0, t: 0, alive: true };
}

/* ------------------------------------------------------------------------------------------ *
 * Aim assist
 * ------------------------------------------------------------------------------------------ */

/**
 * Half-angle of the assist cone, radians (~7 deg). Deliberately well inside
 * docs/ARCHITECTURE.md's server-side aim-plausibility window ("fire direction within **0.22 rad**
 * of the interpolated replicated aim"): assist nudges the shot by at most this much, so a assisted
 * shot can never trip the anti-aimbot envelope it is checked against. That bound is the reason
 * this lives in `packages/shared` and not in the client — when phase 5 moves spear resolution
 * server-side, the server applies the *same* function to the *same* inputs and agrees on where
 * the shaft went, instead of seeing a client aiming 7 deg off its own replicated look direction.
 */
export const ASSIST_CONE = 0.12;
/**
 * How far toward the computed intercept the aim is actually moved, 0..1. Not 1: a hard snap feels
 * like the game taking the shot for you and removes any reason to track a fish. At 0.65 a shot
 * that was close becomes a hit and a shot that was badly off still misses.
 */
export const ASSIST_STRENGTH = 0.65;
/** Assist only engages inside this range — past it the shaft has bled most of its speed
 * (`SPEAR_DRAG_K`) and the shot is not a real attempt anyway. */
export const ASSIST_RANGE = SPEAR_RANGE;

export interface AssistTarget extends CapsuleTarget {
  /** Target velocity, m/s. Optional: a stationary or unknown-velocity target simply gets no lead. */
  vx?: number;
  vy?: number;
  vz?: number;
}

export interface AssistResult {
  /** Unit direction to fire. Equals the input direction when nothing qualified. */
  dx: number; dy: number; dz: number;
  /** The target the assist locked onto, or null. */
  targetId: string | number | null;
  /** Angle the aim was moved, radians — for a HUD tell, and for asserting the cone bound. */
  applied: number;
}

/**
 * Nudges `dir` toward the best nearby spearable target, leading it for travel time.
 *
 * Two things make a speargun hard to aim that this addresses, in order of how much they matter:
 *
 * 1. **Travel time.** The shaft leaves at 25 m/s and *decelerates* (`SPEAR_DRAG_K`), so a shot at
 *    8 m is in the water for over half a second. A fish swimming at 1 m/s has moved most of its
 *    own body length by the time the spear arrives, so aiming *at* it is a clean miss behind —
 *    and the fix players are expected to discover (lead the fish) is invisible underwater with no
 *    tracer. The assist aims at the **intercept point**, solving for where the target and the
 *    decelerating shaft meet.
 * 2. **No sight picture.** There is no rear sight, the view model is off-centre, and refraction
 *    shifts everything. A small adhesion cone compensates without taking the shot over.
 *
 * Non-catchable targets are skipped here exactly as they are in `stepSpear` — the assist must
 * never pull aim toward a dolphin the shaft would then pass straight through.
 */
export function assistAim(
  origin: Vec3,
  dir: Vec3,
  targets: readonly AssistTarget[],
  opts: { cone?: number; strength?: number; range?: number } = {},
): AssistResult {
  const cone = opts.cone ?? ASSIST_CONE;
  const strength = clamp(opts.strength ?? ASSIST_STRENGTH, 0, 1);
  const range = opts.range ?? ASSIST_RANGE;

  const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const ux = dir.x / dl, uy = dir.y / dl, uz = dir.z / dl;

  let bestAng = Infinity;
  let best: { x: number; y: number; z: number; id: string | number } | null = null;

  for (const t of targets) {
    if (t.catchable === false) continue;
    // Capsule midpoint is the aim point; a fish's capsule is its body axis, so the middle is the
    // thickest part and the most forgiving thing to aim at.
    const cx = (t.ax + t.bx) / 2, cy = (t.ay + t.by) / 2, cz = (t.az + t.bz) / 2;
    let px = cx - origin.x, py = cy - origin.y, pz = cz - origin.z;
    const d0 = Math.hypot(px, py, pz);
    if (d0 < 0.3 || d0 > range) continue;

    // Lead: iterate the intercept a couple of times. `timeToDistance` is the inverse of the
    // decelerating travel curve, and moving the aim point changes the distance, which changes the
    // time — two passes converges far inside the capsule radius at these ranges.
    const vx = t.vx ?? 0, vy = t.vy ?? 0, vz = t.vz ?? 0;
    let aimX = cx, aimY = cy, aimZ = cz;
    if (vx || vy || vz) {
      for (let i = 0; i < 2; i++) {
        const d = Math.hypot(aimX - origin.x, aimY - origin.y, aimZ - origin.z);
        const tof = timeToDistance(Math.min(d, SPEAR_RANGE));
        aimX = cx + vx * tof; aimY = cy + vy * tof; aimZ = cz + vz * tof;
      }
    }

    px = aimX - origin.x; py = aimY - origin.y; pz = aimZ - origin.z;
    const pl = Math.hypot(px, py, pz) || 1;
    const cosA = clamp((px * ux + py * uy + pz * uz) / pl, -1, 1);
    const ang = Math.acos(cosA);
    if (ang > cone) continue;
    if (ang < bestAng) { bestAng = ang; best = { x: px / pl, y: py / pl, z: pz / pl, id: t.id }; }
  }

  if (!best) return { dx: ux, dy: uy, dz: uz, targetId: null, applied: 0 };

  // Blend toward the intercept direction and renormalize — a slerp is unnecessary at <=7 deg,
  // where the normalized lerp differs from it by well under a milliradian.
  let nx = ux + (best.x - ux) * strength;
  let ny = uy + (best.y - uy) * strength;
  let nz = uz + (best.z - uz) * strength;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  const applied = Math.acos(clamp(nx * ux + ny * uy + nz * uz, -1, 1));
  return { dx: nx, dy: ny, dz: nz, targetId: best.id, applied };
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
  /** Shaft speed at the moment of impact, m/s — `shaftSpeedAtDist(atDist)`, surfaced so callers
   * can show/reason about it without recomputing. */
  impactSpeed: number;
  /** Whether this hit actually holds (see `holdChance`'s doc comment) — `true` whenever
   * `stepSpear` is called without an `rng` (every existing call site/test that doesn't care about
   * this mechanic keeps its old always-holds behaviour); with an `rng`, a weak edge-of-range hit
   * can come back `false` — a geometric hit that glances off rather than anchoring. */
  held: boolean;
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
 * Advance the shaft by `dt`, clamped to `SPEAR_RANGE`, and test the swept segment against every
 * target. The shaft's speed decays with distance under water drag (`SPEAR_DRAG_K`) — `dist` is
 * derived from cumulative flight time (`distAtFlightTime`), not an accumulated `speed*dt`, so the
 * result is exact regardless of step size (see that constant's doc comment). Pure: returns a new
 * `ShotState` plus the nearest hit this step (by distance along the shaft), or `null`. Once
 * `alive` is false (range exhausted or a hit was already resolved), further calls are no-ops —
 * the caller retires the shot.
 *
 * `rng`, if given, rolls `holdChance` against the impact speed to decide `SpearHit.held` — a weak
 * edge-of-range hit can glance off instead of anchoring. Omit it to keep the old always-holds
 * behaviour (every pre-existing call site/test).
 */
export function stepSpear(
  shot: ShotState, targets: readonly CapsuleTarget[], dt: number, rng?: Rng,
): { shot: ShotState; hit: SpearHit | null } {
  if (!shot.alive) return { shot, hit: null };
  const newT = shot.t + dt;
  const newDist = Math.min(distAtFlightTime(newT), SPEAR_RANGE);
  const travel = newDist - shot.dist;
  const p1 = shaftPosition(shot, shot.dist);
  const p2 = shaftPosition(shot, newDist);

  let best: { target: CapsuleTarget; s: number } | null = null;
  for (const target of targets) {
    // `catchable: false` targets (marine mammals — see `CapsuleTarget.catchable`'s doc comment)
    // are excluded here, structurally, rather than hit-tested and then rejected: the shaft simply
    // cannot register a hit on one. See test/catchable.test.ts.
    if (target.catchable === false) continue;
    const { hit, s } = segmentHitsCapsule(p1, p2, target);
    if (hit && (!best || s < best.s)) best = { target, s };
  }

  if (best) {
    const atDist = shot.dist + travel * best.s;
    const point = shaftPosition(shot, atDist);
    const impactSpeed = shaftSpeedAtDist(atDist);
    const held = rng ? rng() < holdChance(impactSpeed) : true;
    return {
      shot: { ...shot, dist: atDist, t: newT, alive: false },
      hit: { id: best.target.id, atDist, point, impactSpeed, held },
    };
  }
  const alive = newDist < SPEAR_RANGE - 1e-9;
  return { shot: { ...shot, dist: newDist, t: newT, alive }, hit: null };
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
