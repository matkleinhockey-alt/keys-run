/**
 * The boat pistol: ballistics, hit resolution, the magazine, and what a gunshot does to the
 * neighbourhood. Pure — no three.js, no DOM, no clock — so the same functions can be rerun by a
 * server and unit tested (packages/shared/test/handgun.test.ts).
 *
 * This is plinking from a boat in a cartoon fishing game, in the same register as the speargun
 * (sim/spear.ts) it is modelled on: it shoots at fish and seabirds, nothing here knows what a
 * person is, and a hit is a comic reaction rather than anything graphic.
 *
 * ## What is borrowed from sim/spear.ts, and what is not
 *
 * Reused as-is: `CapsuleTarget`, `segmentHitsCapsule` (the swept-segment capsule test) and the
 * shape of an aim-assist cone with a lead solve. Not reused: the shaft's flight model. A speargun
 * shaft is a 25 m/s object whose whole life is spent in water, with drag defined in terms of its
 * range; a bullet is 350 m/s through air, falls under gravity, and its interesting physics is the
 * ONE metre it spends in water at the end. Bending `stepSpear` to cover both would have made it
 * worse at each, so the bullet gets its own small integrator below.
 *
 * ## The water model (why you cannot snipe a fish at 10 m depth)
 *
 * The brief: "water stops a bullet fast; model that honestly". Three effects, in order of how much
 * they matter in play:
 *
 *  1. **Stopping distance.** Once a bullet enters water its speed falls linearly to zero over
 *     `WATER_STOP_M` of travel (so energy, which goes with v squared, falls with the square of the
 *     remainder). A fish is hittable only while the bullet still has `ENERGY_STUN` of its entry
 *     energy. The figure is a cartoon-friendly cousin of the real thing: real pistol rounds are
 *     done inside a metre or two of water. Because it is measured along the PATH, a shallow shot
 *     is penalised far more than a steep one - a fish 0.6 m down needs 0.6 / sin(angle) metres of
 *     bullet-in-water, which is ~1.3 m at 28 degrees but 3.5 m at 10 degrees. That is the effect
 *     that makes you shoot at fish near the boat, from above, which is how it works in life.
 *  2. **Ricochet.** Under `SKIP_ANGLE` of grazing incidence a bullet skips off the surface
 *     instead of entering it (once; a second graze kills it). A flat shot at a distant fish
 *     therefore skips over it and can even clip a bird beyond it.
 *  3. **Nothing below.** Deep fish are not merely hard to hit, they are unreachable: the bullet is
 *     dead at `WATER_STOP_M` whatever you do. The assist also ignores fish below
 *     `ASSIST_MAX_DEPTH_M` so it never pulls your aim toward something the water will refuse.
 *
 * Ignored on purpose: wave slope at the impact point (the surface is treated as locally flat -
 * a ripple would change the grazing angle by a few degrees, inside the noise of the skip
 * threshold), tumbling and deflection in water (the underwater path is straight), and any
 * collision with hulls, docks, or people. Bullets pass over everything but fish, birds, water and
 * ground.
 */
import { segmentHitsCapsule, closestDistSqSegmentSegment, type CapsuleTarget, type Vec3 } from './spear.js';
import { countOf, useOne, type Inventory, type Modifiers } from './shop.js';
import type { Rng } from '../rng/index.js';

/* ------------------------------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------------------------------ */

/** Muzzle speed, m/s. A 9 mm is 350-400; the low end keeps a 60 m shot's time of flight (0.19 s)
 * long enough that leading a bird is a real, if small, thing. */
export const MUZZLE_SPEED = 350;
/** Air drag as an exponential in PATH length: v(s) = v0 * exp(-K s). 0.0016/m leaves 87% of muzzle
 * speed at 90 m, which is about what a pistol round actually keeps. */
export const BULLET_DRAG_K = 0.0016;
export const GRAVITY = 9.81;
/** Bullets are retired past this much path, m. Nothing is that far away in a game this size. */
export const BULLET_RANGE = 120;
/** Integration sub-step, s. 350 m/s * 1/300 s = 1.17 m, comfortably under a bird's capsule
 * diameter, and the swept-segment test means even that does not tunnel. A FIXED constant (not
 * whatever dt the caller passes) so the same shot resolves the same way at any tick rate. */
export const MICRO_DT = 1 / 300;

/** Metres of path through water before a bullet has given up all its speed. */
export const WATER_STOP_M = 2.4;
/** Fraction of entry energy a bullet needs left to count as hitting (stunning) a fish. */
export const ENERGY_STUN = 0.2;
/** Grazing angle (radians) under which a bullet skips off water instead of entering. 5 degrees:
 * the pistol-round figure is 6-10 for flat water; the lower end keeps skips a special case rather
 * than the rule for every shot at something far away. */
export const SKIP_ANGLE = (5 * Math.PI) / 180;
/** Speed kept by a skipping bullet. */
export const SKIP_SPEED_KEEP = 0.7;
/** Fish deeper than this (metres below the local surface, at their capsule's shallowest end) are
 * not offered to the aim assist: the bullet could not get there. */
export const ASSIST_MAX_DEPTH_M = 1.6;

/* --- the gun ------------------------------------------------------------------------------- */

export const MAG_SIZE = 12;
/** s between shots: semi-automatic, as fast as a finger. */
export const FIRE_INTERVAL = 0.2;
/** s to swap a magazine with a round still chambered, and with the slide locked back. */
export const RELOAD_S = 1.7;
export const RELOAD_EMPTY_S = 2.2;
/** Spread (half-angle of a uniform cone, radians): a settled hand, and how much a string of fast
 * shots adds. 0.008 rad is 0.8 m at 100 m and 8 cm at 10 m - a fish-sized group at close range. */
export const SPREAD_BASE = 0.008;
export const SPREAD_PER_HEAT = 0.02;
/** `heat` (0..1) is how shaken the hand is: each shot adds, time takes it away. */
export const HEAT_PER_SHOT = 0.34;
export const HEAT_DECAY_PER_S = 1.5;

export const AMMO_KEY = 'handgun.ammo';
export const EXTMAG_KEY = 'handgun.extmag';
export const DOT_KEY = 'handgun.dot';
export const EXTMAG_BONUS = 6;
export const DOT_SPREAD_MUL = 0.55;

/** Rounds carried per box (kept beside `unitsPer` in sim/shop.ts, which owns the number the shop
 * actually uses; this is the figure the tests and copy quote). */
export const ROUNDS_PER_BOX = 50;

/* ------------------------------------------------------------------------------------------ *
 * Ammunition
 *
 * The inventory (`handgun.ammo`) is the single source of truth for every round the player owns,
 * INCLUDING the ones in the gun: a shot spends one unit, and a reload only moves rounds from "in
 * the box" to "in the magazine" (it costs time, not stock). Rejected: spending a magazine's worth
 * at reload time, which is how a real box works but means rounds sitting in a loaded gun vanish
 * if the page reloads (the magazine is not persisted) - the player pays for ammunition they never
 * fired. This way a reload of the page costs a reload, nothing else.
 * ------------------------------------------------------------------------------------------ */

/** Every round owned, loaded or not. */
export const reserveRounds = (inv: Inventory): number => countOf(inv, AMMO_KEY);

/** Takes up to `want` rounds out of the inventory. Same-reference inventory when none left. */
export function takeRounds(inv: Inventory, want: number): { inventory: Inventory; taken: number } {
  let cur = inv, taken = 0;
  while (taken < want) {
    const next = useOne(cur, AMMO_KEY);
    if (next === cur) break;
    cur = next; taken++;
  }
  return { inventory: cur, taken };
}

/** Magazine capacity for a given set of owned-gear modifiers. */
export const magSizeFor = (m: Pick<Modifiers, 'handgunMagBonus'>): number => MAG_SIZE + Math.max(0, Math.round(m.handgunMagBonus));

/** What the HUD says about ammunition, or null when there is nothing worth saying. */
export function ammoNotice(mag: number, reserve: number): string | null {
  if (mag === 0 && reserve === 0) return 'Out of 9 mm. Deadeye Guns & Ammo sells it by the box.';
  if (mag === 0) return 'Click. Reload (R).';
  if (mag <= 3 && reserve === 0) return `${mag} left and no spare magazine.`;
  return null;
}

/* ------------------------------------------------------------------------------------------ *
 * The gun: magazine, slide, reload, and a hand that gets shaky
 * ------------------------------------------------------------------------------------------ */

export interface GunState {
  /** Rounds in the gun, chambered one included. */
  mag: number;
  /** s until the trigger will release another shot. */
  fireT: number;
  /** True from the moment a reload is started until it completes. */
  reloading: boolean;
  /** s of reload left. */
  reloadT: number;
  /** Whether the reload that is running started on an empty gun (slide locked back). */
  fromEmpty: boolean;
  /** 0..1, shaky-hand accumulator. */
  heat: number;
}

export const createGun = (mag: number = MAG_SIZE): GunState =>
  ({ mag, fireT: 0, reloading: false, reloadT: 0, fromEmpty: false, heat: 0 });

export const canFire = (g: GunState): boolean => !g.reloading && g.fireT <= 0 && g.mag > 0;

export type TriggerResult = 'fired' | 'empty' | 'busy';

/** Pulls the trigger. `empty` is the dry click; `busy` is "the slide is still cycling / you are
 * mid-reload", which deliberately makes no sound so mashing the button does not spam. */
export function pullTrigger(g: GunState): { gun: GunState; result: TriggerResult } {
  if (g.reloading || g.fireT > 0) return { gun: g, result: 'busy' };
  if (g.mag <= 0) return { gun: g, result: 'empty' };
  return {
    gun: { ...g, mag: g.mag - 1, fireT: FIRE_INTERVAL, heat: Math.min(1, g.heat + HEAT_PER_SHOT) },
    result: 'fired',
  };
}

/** Starts a reload if it would do anything: not already running, magazine not full, and rounds
 * to put in it. */
export function startReload(g: GunState, magSize: number, reserve: number): { gun: GunState; started: boolean } {
  if (g.reloading || g.mag >= magSize || reserve <= 0) return { gun: g, started: false };
  const fromEmpty = g.mag === 0;
  return { gun: { ...g, reloading: true, fromEmpty, reloadT: fromEmpty ? RELOAD_EMPTY_S : RELOAD_S }, started: true };
}

/** Advances the gun's clocks. When a reload finishes, `load(want)` is called exactly once to take
 * rounds from the reserve and returns how many it actually found. */
export function stepGun(g: GunState, dt: number, magSize: number, load: (want: number) => number): GunState {
  let { mag, fireT, reloading, reloadT, fromEmpty, heat } = g;
  fireT = Math.max(0, fireT - dt);
  heat = Math.max(0, heat - HEAT_DECAY_PER_S * dt);
  if (reloading) {
    reloadT -= dt;
    if (reloadT <= 0) {
      mag += Math.max(0, Math.min(magSize - mag, load(magSize - mag)));
      reloading = false; reloadT = 0; fromEmpty = false;
    }
  }
  return { mag, fireT, reloading, reloadT, fromEmpty, heat };
}

/** Half-angle of the cone this shot is spread over. `spreadMul` is `Modifiers.handgunSpreadMul`. */
export const spreadFor = (g: GunState, spreadMul = 1): number => (SPREAD_BASE + SPREAD_PER_HEAT * g.heat) * spreadMul;

/** `dir` perturbed uniformly inside a cone of half-angle `spread`. Unit in, unit out. */
export function spreadDir(dir: Vec3, spread: number, rng: Rng): Vec3 {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const ux = dir.x / len, uy = dir.y / len, uz = dir.z / len;
  if (spread <= 0) return { x: ux, y: uy, z: uz };
  // Orthonormal basis (a, b) perpendicular to u.
  let ax: number, ay: number, az: number;
  if (Math.abs(uy) < 0.9) { ax = uz; ay = 0; az = -ux; } else { ax = 0; ay = -uz; az = uy; }
  const al = Math.hypot(ax, ay, az) || 1;
  ax /= al; ay /= al; az /= al;
  const bx = uy * az - uz * ay, by = uz * ax - ux * az, bz = ux * ay - uy * ax;
  // sqrt for a uniform DISC (not a cluster at the centre).
  const r = spread * Math.sqrt(rng()), phi = rng() * Math.PI * 2;
  const ox = Math.cos(phi) * r, oy = Math.sin(phi) * r;
  const x = ux + ax * ox + bx * oy, y = uy + ay * ox + by * oy, z = uz + az * ox + bz * oy;
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
}

/* ------------------------------------------------------------------------------------------ *
 * The bullet
 * ------------------------------------------------------------------------------------------ */

export interface BulletState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  /** Path length so far, m. */
  travelled: number;
  /** Path length spent in water, m. */
  waterPath: number;
  inWater: boolean;
  /** Times it has skipped off the surface. */
  skips: number;
  alive: boolean;
  /** Speed at fire time - what "energy fraction" is measured against. */
  v0: number;
  /** Speed at water entry (the stopping curve starts from here). */
  vEntry: number;
  /** The straight legs it has flown THROUGH AIR (origin -> skip -> ... -> water entry or end).
   * The caller hands these to `Caelen.resolveSpearShot`, which wants a segment. Underwater travel
   * is deliberately not a leg: nothing that lives in the air can be hit there. */
  legs: Array<[Vec3, Vec3]>;
  /** Where the current air leg began. */
  legStart: Vec3;
}

export interface BulletEnv {
  /** Local water-surface height at (x, z), m (the wave field). */
  surfaceY(x: number, z: number): number;
  /** Optional ground height at (x, z); a bullet that dips below it is stopped (an island). */
  groundY?(x: number, z: number): number;
}

export type BulletEventKind = 'splash' | 'skip' | 'thud' | 'spent';
export interface BulletEvent { kind: BulletEventKind; x: number; y: number; z: number; speed: number }

export interface BulletHit {
  id: string | number;
  point: Vec3;
  /** Fraction of the bullet's MUZZLE energy left at impact, 0..1. */
  energy: number;
  /** Metres below the surface of the impact, 0 for a hit in the air. */
  depth: number;
  inWater: boolean;
}

/** A fish or bird to test, with optional velocity for the assist's lead solve. */
export interface BulletTarget extends CapsuleTarget {
  vx?: number; vy?: number; vz?: number;
}

export function fireBullet(origin: Vec3, dir: Vec3, speed: number = MUZZLE_SPEED): BulletState {
  const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
  return {
    x: origin.x, y: origin.y, z: origin.z,
    vx: (dir.x / l) * speed, vy: (dir.y / l) * speed, vz: (dir.z / l) * speed,
    travelled: 0, waterPath: 0, inWater: false, skips: 0, alive: true,
    v0: speed, vEntry: speed, legs: [], legStart: { x: origin.x, y: origin.y, z: origin.z },
  };
}

const energyInWater = (waterPath: number): number => {
  const rem = Math.max(0, 1 - waterPath / WATER_STOP_M);
  return rem * rem;
};

/**
 * Advances a bullet by `dt` (as a whole number of `MICRO_DT` sub-steps, plus a remainder),
 * returning the new state, the first hit if any, and the world events that happened (for splashes,
 * sounds and the Caelen segment). Pure: the input state is not mutated.
 */
export function stepBullet(
  bullet: BulletState, targets: readonly BulletTarget[], dt: number, env: BulletEnv,
): { bullet: BulletState; hit: BulletHit | null; events: BulletEvent[] } {
  const events: BulletEvent[] = [];
  if (!bullet.alive) return { bullet, hit: null, events };
  const b: BulletState = { ...bullet, legs: bullet.legs.slice() };
  /** Closes the current air leg at (x, y, z) - only while the bullet is still in the air. */
  const closeLeg = (x: number, y: number, z: number): void => {
    if (!b.inWater) b.legs.push([b.legStart, { x, y, z }]);
  };
  let remaining = dt;

  while (remaining > 1e-9 && b.alive) {
    const h = Math.min(MICRO_DT, remaining);
    remaining -= h;
    const p1 = { x: b.x, y: b.y, z: b.z };
    const speed = Math.hypot(b.vx, b.vy, b.vz);

    let p2: Vec3;
    let segLen: number;
    if (b.inWater) {
      // Linear deceleration to a stop over WATER_STOP_M: speed = vEntry * (1 - waterPath / STOP).
      const frac = Math.max(0, 1 - b.waterPath / WATER_STOP_M);
      const sp = b.vEntry * frac;
      segLen = Math.min(sp * h, WATER_STOP_M - b.waterPath);
      const k = speed > 0 ? segLen / speed : 0;
      p2 = { x: p1.x + b.vx * k, y: p1.y + b.vy * k, z: p1.z + b.vz * k };
    } else {
      // Gravity first, then drag on the path actually flown.
      b.vy -= GRAVITY * h;
      const sp2 = Math.hypot(b.vx, b.vy, b.vz);
      segLen = sp2 * h;
      p2 = { x: p1.x + b.vx * h, y: p1.y + b.vy * h, z: p1.z + b.vz * h };
      const damp = Math.exp(-BULLET_DRAG_K * segLen);
      b.vx *= damp; b.vy *= damp; b.vz *= damp;
    }

    // --- surface crossing (air -> water) ------------------------------------------------------
    let seg2 = p2;
    let crossed = false;
    if (!b.inWater) {
      const a0 = p1.y - env.surfaceY(p1.x, p1.z), a1 = p2.y - env.surfaceY(p2.x, p2.z);
      if (a0 > 0 && a1 <= 0) {
        const f = a0 / (a0 - a1);
        seg2 = { x: p1.x + (p2.x - p1.x) * f, y: p1.y + (p2.y - p1.y) * f, z: p1.z + (p2.z - p1.z) * f };
        segLen *= f;
        crossed = true;
      }
    }

    // --- hit test along the sub-segment p1 -> seg2 ------------------------------------------
    let best: { t: BulletTarget; s: number } | null = null;
    for (const t of targets) {
      if (t.catchable === false) continue;
      const r = segmentHitsCapsule(p1, seg2, t);
      if (r.hit && (!best || r.s < best.s)) best = { t, s: r.s };
    }
    if (best) {
      const point = { x: p1.x + (seg2.x - p1.x) * best.s, y: p1.y + (seg2.y - p1.y) * best.s, z: p1.z + (seg2.z - p1.z) * best.s };
      const wp = b.inWater ? b.waterPath + segLen * best.s : 0;
      const energy = b.inWater
        ? energyInWater(wp) * (b.vEntry / b.v0) ** 2
        : (Math.hypot(b.vx, b.vy, b.vz) / b.v0) ** 2;
      // A bullet that has already spent itself in the water does not stun the fish it ends beside.
      if (!b.inWater || energy >= ENERGY_STUN * (b.vEntry / b.v0) ** 2) {
        b.x = point.x; b.y = point.y; b.z = point.z; b.alive = false;
        closeLeg(point.x, point.y, point.z);
        return {
          bullet: b,
          hit: {
            id: best.t.id, point, energy,
            depth: b.inWater ? Math.max(0, env.surfaceY(point.x, point.z) - point.y) : 0,
            inWater: b.inWater,
          },
          events,
        };
      }
    }

    b.travelled += segLen;
    if (b.inWater) b.waterPath += segLen;

    if (crossed) {
      b.x = seg2.x; b.y = seg2.y; b.z = seg2.z;
      const sp = Math.hypot(b.vx, b.vy, b.vz) || 1;
      const sinTheta = Math.abs(b.vy) / sp;
      const theta = Math.asin(Math.min(1, sinTheta));
      if (theta < SKIP_ANGLE && b.skips < 1) {
        // Skip: mirror the vertical, keep most of the horizontal, lose some speed.
        b.vy = Math.abs(b.vy) * 0.6 + 2;
        b.vx *= SKIP_SPEED_KEEP; b.vz *= SKIP_SPEED_KEEP;
        b.skips++;
        closeLeg(b.x, b.y, b.z);
        b.legStart = { x: b.x, y: b.y, z: b.z };
        events.push({ kind: 'skip', x: b.x, y: b.y, z: b.z, speed: sp });
      } else if (theta < SKIP_ANGLE) {
        // A second graze: it is spent.
        b.alive = false;
        closeLeg(b.x, b.y, b.z);
        events.push({ kind: 'splash', x: b.x, y: b.y, z: b.z, speed: sp });
      } else {
        closeLeg(b.x, b.y, b.z);
        b.inWater = true; b.waterPath = 0; b.vEntry = sp;
        events.push({ kind: 'splash', x: b.x, y: b.y, z: b.z, speed: sp });
      }
      continue;
    }

    b.x = p2.x; b.y = p2.y; b.z = p2.z;

    if (b.inWater && b.waterPath >= WATER_STOP_M - 1e-9) {
      b.alive = false;
      events.push({ kind: 'spent', x: b.x, y: b.y, z: b.z, speed: 0 });
    } else if (env.groundY && b.y < env.groundY(b.x, b.z)) {
      b.alive = false;
      closeLeg(b.x, b.y, b.z);
      events.push({ kind: 'thud', x: b.x, y: b.y, z: b.z, speed });
    } else if (b.travelled >= BULLET_RANGE) {
      b.alive = false;
      closeLeg(b.x, b.y, b.z);
    }
  }
  return { bullet: b, hit: null, events };
}

/** Minimum distance (m) from a finished bullet's air legs to a point-ish capsule - the "was that
 * a shot AT him" measure the near-miss taunt wants. */
export function minAirDistTo(b: BulletState, a: Vec3, c: Vec3): number {
  let best = Infinity;
  // A bullet still in flight has an open leg: include it up to where it is now.
  const legs = b.alive && !b.inWater ? [...b.legs, [b.legStart, { x: b.x, y: b.y, z: b.z }] as [Vec3, Vec3]] : b.legs;
  for (const [p, q] of legs) {
    const { distSq } = closestDistSqSegmentSegment(p, q, a, c);
    if (distSq < best) best = distSq;
  }
  return Math.sqrt(best);
}

/* ------------------------------------------------------------------------------------------ *
 * Aiming: parallax, drop and lead
 * ------------------------------------------------------------------------------------------ */

export const ASSIST_CONE = 0.09;
/** Less than the speargun's 0.65: a bullet is flat and fast, so the assist's job is mostly the
 * ~2 degrees of parallax between the eye and the barrel, not a lead. */
export const ASSIST_STRENGTH = 0.55;
export const ASSIST_RANGE = 70;
/** How far ahead of the eye the crosshair is taken to converge when nothing is locked, m. */
export const CONVERGE_M = 30;

export interface BulletAssist {
  dx: number; dy: number; dz: number;
  targetId: string | number | null;
  applied: number;
}

/**
 * The direction to fire from `muzzle` given that the player's crosshair points along `dir` from
 * `eye`. With no target in the cone it simply converges the barrel on the crosshair at
 * `CONVERGE_M` (an unassisted shot still hits where you look, to within parallax); with one it
 * leads the target for the time of flight and drop, and moves the aim `strength` of the way.
 * Mirrors sim/spear.ts `assistAim` (same eye-vs-origin split, for the same reason) with a
 * constant-speed time of flight in place of the shaft's decelerating one.
 */
export function aimBullet(
  muzzle: Vec3, eye: Vec3, dir: Vec3, targets: readonly BulletTarget[],
  opts: { cone?: number; strength?: number; range?: number; assist?: boolean } = {},
): BulletAssist {
  const cone = opts.cone ?? ASSIST_CONE;
  const strength = Math.min(1, Math.max(0, opts.strength ?? ASSIST_STRENGTH));
  const range = opts.range ?? ASSIST_RANGE;
  const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const ux = dir.x / dl, uy = dir.y / dl, uz = dir.z / dl;

  const toward = (px: number, py: number, pz: number): BulletAssist => {
    const x = px - muzzle.x, y = py - muzzle.y, z = pz - muzzle.z;
    const l = Math.hypot(x, y, z) || 1;
    return { dx: x / l, dy: y / l, dz: z / l, targetId: null, applied: 0 };
  };
  // Unassisted: converge on the crosshair, plus the drop over the flight to that point.
  const tofC = CONVERGE_M / (MUZZLE_SPEED * 0.97);
  const noTarget = (): BulletAssist =>
    toward(eye.x + ux * CONVERGE_M, eye.y + uy * CONVERGE_M + 0.5 * GRAVITY * tofC * tofC, eye.z + uz * CONVERGE_M);
  if (opts.assist === false) return noTarget();

  let best: { x: number; y: number; z: number; id: string | number; ang: number } | null = null;
  for (const t of targets) {
    if (t.catchable === false) continue;
    const cx = (t.ax + t.bx) / 2, cy = (t.ay + t.by) / 2, cz = (t.az + t.bz) / 2;
    const d0 = Math.hypot(cx - muzzle.x, cy - muzzle.y, cz - muzzle.z);
    if (d0 < 0.3 || d0 > range) continue;
    const tof = d0 / (MUZZLE_SPEED * 0.97);
    const ax = cx + (t.vx ?? 0) * tof, ay = cy + (t.vy ?? 0) * tof + 0.5 * GRAVITY * tof * tof, az = cz + (t.vz ?? 0) * tof;
    const ex = ax - eye.x, ey = ay - eye.y, ez = az - eye.z;
    const el = Math.hypot(ex, ey, ez) || 1;
    const ang = Math.acos(Math.min(1, Math.max(-1, (ex * ux + ey * uy + ez * uz) / el)));
    if (ang > cone) continue;
    if (!best || ang < best.ang) best = { x: ax, y: ay, z: az, id: t.id, ang };
  }
  if (!best) return noTarget();

  const bx = best.x - eye.x, by = best.y - eye.y, bz = best.z - eye.z;
  const bl = Math.hypot(bx, by, bz) || 1;
  let ax = ux + (bx / bl - ux) * strength, ay = uy + (by / bl - uy) * strength, az = uz + (bz / bl - uz) * strength;
  const al = Math.hypot(ax, ay, az) || 1;
  ax /= al; ay /= al; az /= al;
  const r = toward(eye.x + ax * bl, eye.y + ay * bl, eye.z + az * bl);
  const applied = Math.acos(Math.min(1, Math.max(-1, r.dx * ux + r.dy * uy + r.dz * uz)));
  return { ...r, targetId: best.id, applied };
}

/** True when a fish capsule's shallowest end is shallow enough to be worth offering the assist. */
export const fishWithinReach = (capsuleTopY: number, surfaceY: number): boolean => surfaceY - capsuleTopY <= ASSIST_MAX_DEPTH_M;

/* ------------------------------------------------------------------------------------------ *
 * Consequences: what the bang does to the neighbourhood
 * ------------------------------------------------------------------------------------------ */

/** Birds within this of the shooter bolt at the report, m. */
export const REPORT_BIRD_M = 140;
/** Seconds a startled bird stays away, and a bird that was actually hit (the sulk). */
export const BIRD_SCATTER_S = 25;
export const BIRD_HIT_S = 90;
/** Seconds a gunshot keeps schools spooked, per shot. */
export const FISH_SPOOK_S = 6;

/** How long a bird of this kind stays away, scared vs struck. Bigger birds sulk longer. */
export function birdAwaySeconds(kind: string, struck: boolean): number {
  const scale = kind === 'pelican' ? 1.4 : kind === 'frigate' ? 1.6 : 1;
  return (struck ? BIRD_HIT_S : BIRD_SCATTER_S) * scale;
}

export interface Spook { x: number; z: number; ttl: number }

/**
 * Where a gunshot should frighten fish, as (x, z, seconds) points the fish module's existing
 * `kind: 'spear'` threat is placed at. entities/fish/behavior.ts gives a spear threat a 6-12 m
 * radius by class; a gunshot is a louder spear, so it is several of them: under the shooter (the
 * report carries through the hull), along the bullet's path where it meets the water, and at the
 * splash. Together they clear a swath ~20 m wide, which is the "fish spook" the brief asks for
 * without touching fish/behavior.ts.
 */
export function gunshotSpooks(shooter: { x: number; z: number }, impact: { x: number; z: number } | null): Spook[] {
  const out: Spook[] = [{ x: shooter.x, z: shooter.z, ttl: FISH_SPOOK_S }];
  if (impact) {
    out.push({ x: impact.x, z: impact.z, ttl: FISH_SPOOK_S });
    const dx = impact.x - shooter.x, dz = impact.z - shooter.z;
    const d = Math.hypot(dx, dz);
    for (let s = 9; s < d - 4; s += 9) out.push({ x: shooter.x + (dx / d) * s, z: shooter.z + (dz / d) * s, ttl: FISH_SPOOK_S * 0.7 });
  }
  return out;
}

/**
 * Chance that a bird scatters at a gunshot. Distance to the SHOOTER matters (a report is loud and
 * a bird 130 m away barely cares), and distance to the BULLET'S PATH matters much more (something
 * that cracked past a gull's ear is a thing it will remember). Partial on purpose: if every shot
 * cleared every bird in earshot the mode would have exactly one shot's worth of targets in it.
 */
export function birdScatterChance(distToShooter: number, distToPath: number): number {
  const ear = Math.max(0, 1 - distToShooter / REPORT_BIRD_M) * 0.6;
  const whiz = distToPath < 6 ? 0.85 : distToPath < 14 ? 0.35 : 0;
  return Math.min(1, Math.max(ear, whiz));
}
