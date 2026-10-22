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
/**
 * Effective range, m (projectile lifetime, not a hard raycast distance).
 *
 * Raised from 11 m. 11 was defensible on paper — it is about what a real band gun does — but in
 * play it put the fish you could see outside the range you could shoot, which reads as the gun
 * being broken rather than the shot being long. Note this constant is load-bearing beyond the
 * cutoff: `SPEAR_DRAG_K` is defined in terms of it, so the shaft still retains 60% of muzzle
 * speed at maximum range and `holdChance` still makes the far edge unreliable rather than free.
 * A longer shot is also a longer flight, so leading matters more, which aim assist already does.
 */
export const SPEAR_RANGE = 18;
/** s, the recover/brace phase after a shot: the gun is dead weight while the diver gets the butt
 * back against the hip and finds the rubbers. Drawing cannot begin until it has elapsed. */
export const SPEAR_RELOAD = 1.8;
export const SPEAR_RELOAD_FLOOR = 1.6; // s, hard anti-cheat floor — never fire faster than this
/** s of uninterrupted, stationary hauling to take the bands from slack to locked on the sear. The
 * whole reload is therefore at least SPEAR_RELOAD + SPEAR_DRAW_TIME = 4.6 s (was a 2.5 s timer),
 * and it is the player's hand doing it — see `stepReload`. */
export const SPEAR_DRAW_TIME = 2.8;
/** Notches on the draw: a band that has been hauled past a notch holds there when the hand lets
 * go, instead of springing all the way back. Without them a single interrupted pull (a fish
 * wandering in, a need to kick) throws away the whole reload, which reads as punishing rather
 * than as effort. */
export const SPEAR_DRAW_NOTCHES = 3;
/** Draw fraction lost per second when the hand is off the bands, down to the last notch passed. */
export const SPEAR_DRAW_SLIP = 0.45;
/** Swim speed (m/s) at which the draw rate has fallen to `SPEAR_DRAW_MIN_RATE`. A real diver
 * braces the butt against the hip and hauls with both arms; kicking along while doing it costs
 * leverage, so you have to hang still in the water to load quickly. */
export const SPEAR_DRAW_SWIM_SPEED = 1.4;
export const SPEAR_DRAW_MIN_RATE = 0.35;

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
export const SPEAR_DRAG_K = dragKFor(SPEAR_RANGE); // ≈0.556 / s at 18 m

/**
 * The drag constant for a gun of a given effective range.
 *
 * WHY THIS IS A FUNCTION OF RANGE and not a fixed K with a longer cutoff. The long-range band gun
 * (`spear.long`, +6 m) must extend reach without making the extra reach free. Two designs:
 *   - Keep K (0.556/s), raise the cutoff to 24 m. REJECTED: it breaks the relationship K was
 *     defined by. The shaft would arrive at 24 m with 47% of muzzle speed (holdChance 0.34
 *     against the stock edge's 0.55), so the new band is MORE unreliable than the old edge, and
 *     inside 18 m the "upgrade" would fly exactly like the stock gun: the item buys a worse
 *     far band and nothing else.
 *   - Keep the *relationship* K was defined by: 60% of muzzle speed is lost by the cutoff
 *     (`K = 0.4 * v / range`, the line above). The long gun's far edge (24 m) is then exactly as
 *     unreliable as the stock edge (60% of muzzle speed retained, holdChance 0.55: the same
 *     curve, stretched), and it is strictly better at any *shared* distance (lower K = faster
 *     shaft = less lead needed; e.g. 18 m in 0.86 s vs 0.92 s). CHOSEN.
 * So reach grows, the unreliable band moves outward with it, and no distance becomes a sure hit.
 * `SPEAR_DRAG_K` stays the stock gun's value so everything that imported it is unchanged.
 */
export function dragKFor(range: number): number {
  return (0.4 * SPEAR_SPEED) / range;
}

/** Largest range any gun can have: the stock 18 m plus the long gun's +6 m. world.ts sizes its
 * fish query radius from this so the longest legal shot is never clipped. Pinned against
 * `modifiersFor` by test/gear.test.ts so a shop change that grows the bonus fails loudly. */
export const SPEAR_RANGE_MAX = SPEAR_RANGE + 6;

/** A spare shaft (see sim/gear.ts `SPARE_SHAFT_RANGE_MUL`) flies this fraction of stock range. */
export const SPEAR_SPARE_RANGE_MUL = 0.6;

/**
 * Effective range of the gun given its range bonus and whether it is firing a bought shaft or the
 * bent spare. Clamped to [stock*spare, SPEAR_RANGE_MAX] so a bad modifier can neither make the
 * shaft stall inside the muzzle nor outrun the world's query radius.
 */
export function spearRangeFor(rangeBonusM: number, spare = false): number {
  const r = (SPEAR_RANGE + Math.max(0, rangeBonusM)) * (spare ? SPEAR_SPARE_RANGE_MUL : 1);
  return clamp(r, SPEAR_RANGE * SPEAR_SPARE_RANGE_MUL, SPEAR_RANGE_MAX);
}

export interface Vec3 { x: number; y: number; z: number }

/** Closed-form distance traveled after `t` seconds of flight from the muzzle — see
 * `SPEAR_DRAG_K`'s doc comment for why this must be evaluated from cumulative elapsed time, never
 * accumulated step-by-step. Not range-clamped; callers clamp to `SPEAR_RANGE` themselves (`stepSpear`
 * does). */
export function distAtFlightTime(t: number, range: number = SPEAR_RANGE): number {
  const k = dragKFor(range);
  return (SPEAR_SPEED / k) * (1 - Math.exp(-k * t));
}

/**
 * Inverse of `distAtFlightTime`: seconds of flight to cover `dist` metres. Closed form — invert
 * `d = (v/k)(1 - e^-kt)` to `t = -ln(1 - dk/v)/k`.
 *
 * Used by `assistAim` to lead a moving target by the shaft's real time of flight. The log's
 * argument goes non-positive at the shaft's asymptotic maximum range (`v/k`, ~27.5 m — well past
 * `SPEAR_RANGE`), so it is clamped to keep this finite for any input a caller can produce.
 */
export function timeToDistance(dist: number, range: number = SPEAR_RANGE): number {
  const k = dragKFor(range);
  const maxD = SPEAR_SPEED / k;
  const frac = clamp(dist / maxD, 0, 0.999);
  return -Math.log(1 - frac) / k;
}

/** Instantaneous shaft speed after traveling `dist` meters from the muzzle. Linear in distance —
 * the algebraic consequence of `SPEAR_DRAG_K`'s exponential-in-time decay (substitute `t` out of
 * `v(t)` and `dist(t)`; see that constant's doc comment) — clamped at 0 defensively, though
 * `SPEAR_RANGE`'s hard cutoff means a real shaft never travels far enough to reach it. */
export function shaftSpeedAtDist(dist: number, range: number = SPEAR_RANGE): number {
  return Math.max(0, SPEAR_SPEED - dragKFor(range) * dist);
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
  /** Seconds remaining of the post-shot recover/brace phase. While > 0 the hand cannot draw. */
  reloadT: number;
  /** 0 = bands slack, 1 = drawn and locked on the sear (loaded). Only the player's hauling moves
   * it up; it only ever reaches 1 after `reloadT` has reached 0, so the total reload can never be
   * shorter than SPEAR_RELOAD_FLOOR however the hand input is faked. */
  draw: number;
}

/** What the player's hands are doing this tick. */
export interface ReloadHand {
  /** Holding the draw control (R / the touch draw button). */
  drawing: boolean;
  /** Diver speed, m/s — kicking while hauling costs leverage (SPEAR_DRAW_SWIM_SPEED). */
  speed: number;
}

export const IDLE_HAND: ReloadHand = { drawing: false, speed: 0 };

export const createGun = (): GunState => ({ reloadT: 0, draw: 1 });

export const canFire = (gun: GunState): boolean => gun.reloadT <= 0 && gun.draw >= 1;

/** Draw-rate multiplier for a given swim speed: 1 hanging still, falling linearly to
 * SPEAR_DRAW_MIN_RATE at SPEAR_DRAW_SWIM_SPEED and beyond. */
export function drawRateFor(speed: number): number {
  const k = clamp(speed / SPEAR_DRAW_SWIM_SPEED, 0, 1);
  return 1 - (1 - SPEAR_DRAW_MIN_RATE) * k;
}

/**
 * Advances the reload by `dt`. Pure — returns a new `GunState` (or the same object once loaded).
 *
 * Phase 1: `reloadT` counts down on its own — the gun cannot be worked yet. Phase 2: while the
 * hand holds the draw, `draw` climbs at `drawRateFor(speed) / SPEAR_DRAW_TIME` per second; let go
 * and it slips back toward the last notch passed at SPEAR_DRAW_SLIP per second. The notch is a
 * floor under the slip only — it never advances the draw by itself.
 *
 * Phase boundary: the tick on which `reloadT` expires does not also draw, so the earliest possible
 * `canFire` is strictly later than SPEAR_RELOAD_FLOOR even with a perfect hand.
 */
export function stepReload(gun: GunState, dt: number, hand: ReloadHand = IDLE_HAND, reloadMul = 1): GunState {
  if (gun.draw >= 1 && gun.reloadT <= 0) return gun;
  if (gun.reloadT > 0) return { reloadT: Math.max(0, gun.reloadT - dt), draw: gun.draw };
  let draw = gun.draw;
  if (hand.drawing) {
    // `reloadMul` < 1 is a faster draw (sim/shop.ts's `Modifiers.spearReloadMul`, the gun shop's
    // band gun and reel conversion). It scales ONLY this hauled phase — the braced recover phase
    // above is governed by SPEAR_RELOAD_FLOOR, which is an anti-cheat bound that no purchase may
    // buy past. Clamped so a future item cannot make the draw instant and collapse the mechanic.
    const k = 1 / Math.max(0.35, reloadMul);
    draw = Math.min(1, draw + ((dt * k) / SPEAR_DRAW_TIME) * drawRateFor(hand.speed));
  } else {
    const notch = Math.floor(draw * SPEAR_DRAW_NOTCHES + 1e-9) / SPEAR_DRAW_NOTCHES;
    draw = Math.max(notch, draw - SPEAR_DRAW_SLIP * dt);
  }
  return { reloadT: 0, draw };
}

/** Starts the reload after a shot: slack bands, and a recover phase of `reloadS`. The anti-cheat
 * floor (`SPEAR_RELOAD_FLOOR`) clamps `reloadS` — a caller can lengthen the recover phase, never
 * shorten it below the floor. */
export function startReload(reloadS: number = SPEAR_RELOAD): GunState {
  return { reloadT: Math.max(SPEAR_RELOAD_FLOOR, reloadS), draw: 0 };
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
  /** This shot's effective range, m (its own gun's — see `spearRangeFor`). Optional so every
   * pre-existing literal/fixture means the stock gun; `stepSpear` reads `shot.range ?? SPEAR_RANGE`. */
  range?: number;
}

/** legacy-free, net-new: `fire` just normalizes direction and starts the shaft at `dist=0`. The
 * caller is responsible for gating this on `canFire`/consuming a `GunState` reload — this
 * function only knows about the projectile. */
export function fire(origin: Vec3, dir: Vec3, range: number = SPEAR_RANGE): ShotState {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  return { ox: origin.x, oy: origin.y, oz: origin.z, dx: dir.x / len, dy: dir.y / len, dz: dir.z / len, dist: 0, t: 0, alive: true, range };
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
/**
 * Widened 0.12 -> 0.17 rad (~6.9 deg -> ~9.7 deg). The old cone was tuned before anyone had tried
 * to hit a small schooling fish with this gun: a yellowtail subtends well under a degree at
 * typical spearing range, so a 6.9 deg cone only helped if you were already nearly on target.
 *
 * Still comfortably inside docs/ARCHITECTURE.md's 0.22 rad server aim-plausibility window, which
 * is the load-bearing constraint — assist must never push a shot outside the cone the server is
 * willing to believe, or every assisted hit reads as an aimbot and gets rejected. 0.17 leaves
 * 0.05 rad of headroom for the client/server interpolation disagreement that window exists to
 * absorb.
 */
export const ASSIST_CONE = 0.17;
/**
 * How far toward the computed intercept the aim is actually moved, 0..1.
 *
 * Not 1: a hard snap feels like the game taking the shot for you and removes any reason to
 * track a fish. At 0.65 a shot that was close becomes a hit and a shot that was badly off still
 * misses.
 *
 * Measured note: raising this to 0.88 was tried and changed nothing (3/12 -> 2/12 on a tracked
 * yellowtail at 4-7 m, i.e. noise). Residual lead is therefore NOT what misses are made of here,
 * so this stays where it was rather than being quietly inflated toward an aimbot for no gain.
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
  opts: { cone?: number; strength?: number; range?: number; eye?: Vec3 } = {},
): AssistResult {
  const cone = opts.cone ?? ASSIST_CONE;
  const strength = clamp(opts.strength ?? ASSIST_STRENGTH, 0, 1);
  // `range` is both the assist reach and the shaft's ballistic range: the gun that will fire the
  // shot (long gun, spare shaft) decides how far the lead must be solved for.
  const range = opts.range ?? ASSIST_RANGE;
  // The frame the PLAYER aims in. `origin` is where the shaft physically leaves (the muzzle);
  // `eye` is where the crosshair is measured from (the camera). They are not the same point, and
  // conflating them is a real bug: the cone test used to compare the camera's forward vector
  // against the *muzzle*-to-target vector, so at close range — where the muzzle offset subtends
  // several degrees — assist stopped locking precisely when the player had the crosshair dead on
  // the fish. Measured: assist failed to lock on 2 of 8 well-aimed shots, and those 2 were
  // guaranteed misses.
  const eye = opts.eye ?? origin;

  const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const ux = dir.x / dl, uy = dir.y / dl, uz = dir.z / dl;

  let bestAng = Infinity;
  let best: { x: number; y: number; z: number; vx: number; vy: number; vz: number; id: string | number } | null = null;

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
        const tof = timeToDistance(Math.min(d, range), range);
        aimX = cx + vx * tof; aimY = cy + vy * tof; aimZ = cz + vz * tof;
      }
    }

    // Cone test from the eye, because that is what the crosshair means.
    const ex = aimX - eye.x, ey = aimY - eye.y, ez = aimZ - eye.z;
    const el = Math.hypot(ex, ey, ez) || 1;
    const ang = Math.acos(clamp((ex * ux + ey * uy + ez * uz) / el, -1, 1));
    if (ang > cone) continue;
    if (ang < bestAng) {
      bestAng = ang;
      // Keep the target's CURRENT centre and its velocity, not the intercept: the blend below has
      // to adhere toward where the fish is and lead from there, and those two corrections get
      // different strengths. The final firing direction is then computed from the muzzle to that
      // point, or the shaft leaves parallel to the eye's line instead of converging on it.
      best = { x: cx, y: cy, z: cz, vx, vy, vz, id: t.id };
    }
  }

  if (!best) return { dx: ux, dy: uy, dz: uz, targetId: null, applied: 0 };

  // Two corrections, and they are NOT the same kind of thing — which is the bug this shape fixes.
  //
  //  - ADHESION, toward where the fish actually is, covers the player's own aim error. `strength`
  //    < 1 belongs here: it is what keeps a badly-aimed shot a miss.
  //  - LEAD, from there to the intercept, covers the shaft's travel time. The player has no
  //    instrument for this — no tracer, no sight, refraction shifting everything — so scaling it
  //    down is not "partial assist", it is a guaranteed miss whenever the lead exceeds the
  //    capsule. Measured in the real game: the shaft needs 0.61 s to reach 13 m and a 1 m/s fish
  //    moves 0.61 m in that time, against capsules of 0.12-0.33 m radius. At strength 0.65 the
  //    shot was aimed 0.21 m behind a 0.3 m fish and missed every time, which is why the gun was
  //    useless past about 9 m while claiming 18.
  //
  // So adhesion is blended and lead is applied in full, and the TOTAL is then clamped to the cone
  // below — the anti-aimbot bound still holds, it is just no longer spent on physics the player
  // cannot see.
  const d0b = Math.hypot(best.x - eye.x, best.y - eye.y, best.z - eye.z);
  const rpx = eye.x + ux * d0b, rpy = eye.y + uy * d0b, rpz = eye.z + uz * d0b;
  const adhX = rpx + (best.x - rpx) * strength;
  const adhY = rpy + (best.y - rpy) * strength;
  const adhZ = rpz + (best.z - rpz) * strength;
  let leadX = adhX, leadY = adhY, leadZ = adhZ;
  if (best.vx || best.vy || best.vz) {
    for (let i = 0; i < 2; i++) {
      const d = Math.hypot(leadX - origin.x, leadY - origin.y, leadZ - origin.z);
      const tof = timeToDistance(Math.min(d, range), range);
      leadX = adhX + best.vx * tof; leadY = adhY + best.vy * tof; leadZ = adhZ + best.vz * tof;
    }
  }
  const bx = leadX - eye.x, by = leadY - eye.y, bz = leadZ - eye.z;
  const bl = Math.hypot(bx, by, bz) || 1;
  let ax = bx / bl, ay = by / bl, az = bz / bl;
  // Clamp the whole correction to the cone — the server plausibility bound (docs/ARCHITECTURE.md)
  // applies to the aim that leaves the client, however the correction was arrived at. Rotating
  // partway along the arc from the player's own aim is how a correction that would overshoot the
  // bound degrades: the shot is still helped, just not past what the server will believe.
  const dot = clamp(ax * ux + ay * uy + az * uz, -1, 1);
  const want = Math.acos(dot);
  if (want > cone) {
    // Gram-Schmidt the perpendicular component out of the desired aim, then rotate `cone` along it.
    let px3 = ax - ux * dot, py3 = ay - uy * dot, pz3 = az - uz * dot;
    const pl3 = Math.hypot(px3, py3, pz3) || 1;
    px3 /= pl3; py3 /= pl3; pz3 /= pl3;
    const c = Math.cos(cone), sN = Math.sin(cone);
    ax = ux * c + px3 * sN; ay = uy * c + py3 * sN; az = uz * c + pz3 * sN;
  }
  const al = Math.hypot(ax, ay, az) || 1;
  ax /= al; ay /= al; az /= al;
  // Convert that aim into a direction the SHAFT can use: point the muzzle at the spot the blended
  // eye-ray reaches at the target's own distance. This is geometry, not assist — the parallax
  // correction is applied in full, while `strength` still governs how much the aim itself moved.
  const px2 = eye.x + ax * bl - origin.x;
  const py2 = eye.y + ay * bl - origin.y;
  const pz2 = eye.z + az * bl - origin.z;
  const pl2 = Math.hypot(px2, py2, pz2) || 1;
  let nx = px2 / pl2, ny = py2 / pl2, nz = pz2 / pl2;
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
  const range = shot.range ?? SPEAR_RANGE;
  const newDist = Math.min(distAtFlightTime(newT, range), range);
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
    const impactSpeed = shaftSpeedAtDist(atDist, range);
    const held = rng ? rng() < holdChance(impactSpeed) : true;
    return {
      shot: { ...shot, dist: atDist, t: newT, alive: false },
      hit: { id: best.target.id, atDist, point, impactSpeed, held },
    };
  }
  const alive = newDist < range - 1e-9;
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

/** Stock tether, m. */
export const SPEAR_TETHER_M = 15;

/**
 * `tetherMul` is `Modifiers.spearTetherMul` (reel-line conversion, x0.6 -> 9 m): the fish can run
 * only that far before the line stops it, so it is hauled in sooner and spends less of the
 * diver's breath. It shortens the *fight*, not the odds of the shaft tearing free (that is
 * tension, which the tether does not touch), so the conversion is a convenience and a breath
 * saver, not a guaranteed landing. Floor of 4 m keeps a bad multiplier from pinning the fish on
 * top of the diver, where `dist < 1.2` landing would trigger without any hauling.
 */
export function spearFightParamsFor(key: string, weight: number, tetherMul = 1): SpearFightParams {
  const S = SPECIES[key];
  const sizeT = clamp((weight - S.min) / (S.max - S.min), 0, 1);
  return { key, weight, str: S.str * (0.8 + 0.55 * sizeT), tetherMax: Math.max(4, SPEAR_TETHER_M * tetherMul) };
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
