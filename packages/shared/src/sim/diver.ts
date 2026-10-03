/**
 * Pure freedive physics: breath-hold air budget, depth-dependent (ATA) air burn, the buoyancy
 * curve that inverts around neutral depth, exertion, narcosis, blackout and shallow-water
 * blackout, fin-kick swim control, drag and a gentle depth-dependent current.
 *
 * There is no legacy code to port here — legacy/index.html has no underwater gameplay at all
 * (see docs/ARCHITECTURE.md "The underwater world"). This models real freediving physiology per
 * that doc's "Freedive physics — this is the gameplay" section, which is deliberately *also* the
 * game design: buoyancy assists descent and fights ascent, and depth burns air disproportionately
 * fast, so depth is self-limiting with no artificial gate.
 *
 * Pure like sim/boat.ts: plain `{x,y,z}` numbers, never `THREE.Vector3`, no DOM, no
 * `Date.now()`/`performance.now()` (callers pass `env.t`). This runs on BOTH the client
 * (prediction) and, later, the server (authority) — see docs/ARCHITECTURE.md's authority table
 * ("diver everything: server, client predicts with input replay"). `step*(state, input, env, dt)
 * -> state` matches sim/boat.ts's convention exactly, including allocating a fresh state object
 * per call (see ARCHITECTURE.md's "Conventions" and its GC-discipline note — same resolution
 * applies here: keep the functional signature, add an in-place sibling later only if profiling
 * says to).
 *
 * Depth convention: `y` is world height, sea level datum at y=0, exactly like `BoatState.y`.
 * `depth = max(0, -y)` everywhere below — the small positive `y` a diver has breaking the
 * surface is freeboard, not depth, and every physiology calc clamps it away.
 *
 * Seafloor integration point: the real seafloor agent is concurrently building chunked LOD
 * terrain that will expose `seafloorHeightAt(x,z)`. Until that lands, callers satisfy
 * `DiverEnv.seafloor` with a small adapter over the existing bathymetry (e.g.
 * `{ heightAt: (x, z) => -depthAt(x, z) }`, see apps/client/src/entities/diver/physics.ts) — a
 * flat bathymetric floor, not the real mesh. Swap the real sampler in behind this same
 * one-method `SeafloorSampler` interface; nothing in this file needs to change.
 */

import { clamp } from '../internal/math.js';

// ---------------------------------------------------------------------------------------------
// Tuning constants (exported so tests and the client HUD/tuning can read the same numbers the
// sim uses — see docs/ARCHITECTURE.md's "Freedive physics" bullets for the sources).
// ---------------------------------------------------------------------------------------------

/** Breath-hold budget at the surface, at rest (ATA=1, exertion=0) — doc: "~90 s at the surface". */
export const AIR_MAX = 90;

/** |y| within this of the y=0 datum counts as "at the surface" for refill/shallow-blackout exemption. */
export const SURFACE_EPS = 0.3;

/** A fresh breath at the surface tops off in ~3 s — fast enough that surfacing feels like relief,
 * not another chore, without being instant (instant would remove the "breathe, then dive again"
 * rhythm the whole mechanic depends on). */
export const SURFACE_REFILL_RATE = AIR_MAX / 3;

/** Depth at which buoyancy crosses zero — doc: "neutral ~10-12 m". Exactly in that band. */
export const NEUTRAL_DEPTH = 11;

/** Upward accel (m/s^2) at the surface — you must actively kick down against this to descend. */
export const BUOY_SURFACE_ACCEL = 1.4;

/** Downward accel (m/s^2) cap once deep below neutral — the "freefall" doc describes. */
export const BUOY_MAX_NEGATIVE_ACCEL = 2.0;

/** Doc: "Narcosis below 25 m" — exposed as a flag; the renderer owns the visual. */
export const NARCOSIS_DEPTH = 25;

/** Doc: "Shallow-water blackout can trigger in the final 5 m of ascent". */
export const SHALLOW_BLACKOUT_DEPTH = 5;

/** Below this fraction of AIR_MAX (~7 s) inside the shallow band, an active ascent risks SWB. */
export const SHALLOW_BLACKOUT_AIR_FRACTION = 0.08;

/** Must be actively ascending (m/s, +y) for the shallow-water-blackout rule to apply — resting at
 * 3 m on fumes is merely desperate, not a shallow-water-blackout case. */
export const SHALLOW_BLACKOUT_MIN_ASCENT = 0.15;

/** Full exertion roughly doubles the ATA-driven air burn on top (doc: "Exertion multiplies air
 * burn — sprint-kicking or fighting a fish drains you faster"). */
export const EXERTION_AIR_GAIN = 1.2;

/** Base fin-kick acceleration (m/s^2) and the sprint multiplier on top of it. */
export const SWIM_KICK_ACCEL = 2.6;
export const SPRINT_MULT = 1.9;

/** Dedicated ascend/descend kick (m/s^2), independent of look pitch — doc lists "ascend/descend"
 * as its own control alongside look-to-steer, so looking straight up/down isn't the only way up. */
export const VERTICAL_KICK_ACCEL = 2.2;

/** Water drag, applied as `v *= max(0, 1 - WATER_DRAG*dt)` each step. */
export const WATER_DRAG = 1.6;

export const EXERTION_RISE_RATE = 2.5;
export const EXERTION_FALL_RATE = 0.6;

/** How long the client should hold tunnel-vision/fade before "you wake on the boat" — a timing
 * hint for the presentation layer, not enforced here (this module doesn't know where the boat
 * is; see apps/client/src/entities/diver/controller.ts for the actual handoff). */
export const BLACKOUT_WAKE_DELAY = 2.5;

/** Collision radius against the seafloor sampler. */
export const DIVER_RADIUS = 0.35;

// ---------------------------------------------------------------------------------------------
// Physiology model — exported standalone so they're directly unit-testable (see
// packages/shared/test/diver.test.ts) without having to reverse-engineer them out of stepDiver.
// ---------------------------------------------------------------------------------------------

/** Atmospheres absolute at a given depth — doc: "ATA = 1 + depth/10". */
export function ataAt(depth: number): number {
  return 1 + depth / 10;
}

/**
 * Buoyancy acceleration (m/s^2, +up) at a given depth. Linear in depth, zero exactly at
 * NEUTRAL_DEPTH, clamped to [BUOY_SURFACE_ACCEL, -BUOY_MAX_NEGATIVE_ACCEL] — positive 0-10 m,
 * neutral ~10-12 m, negative (freefall) below, per doc.
 */
export function buoyancyAccel(depth: number): number {
  const raw = BUOY_SURFACE_ACCEL * (1 - depth / NEUTRAL_DEPTH);
  return clamp(raw, -BUOY_MAX_NEGATIVE_ACCEL, BUOY_SURFACE_ACCEL);
}

/** Air burn rate (budget-units/s) at a given depth and exertion (0..1). At depth=0, exertion=0
 * this is exactly 1, i.e. AIR_MAX seconds lasts AIR_MAX seconds — the doc's anchor case. */
export function airBurnRate(depth: number, exertion: number): number {
  return ataAt(depth) * (1 + clamp(exertion, 0, 1) * EXERTION_AIR_GAIN);
}

/**
 * Deterministic depth-dependent current (m/s, horizontal). Pure function of position/depth/time
 * — no RNG, no module state — so prediction replay and the determinism test below are exact.
 * Magnitude grows with depth (doc gives no exact curve for this; this is a gentle, capped ramp
 * that makes the deep wall feel different from the flats without fighting the player on the
 * shallow bands where fin control should feel precise).
 */
export function currentAt(x: number, z: number, depth: number, t: number): { x: number; z: number } {
  const mag = 0.05 + 0.1 * Math.min(depth, 40) / 40;
  const dir = Math.sin(x * 0.0011 + z * 0.0008 + t * 0.015) * Math.PI * 2;
  return { x: Math.cos(dir) * mag, z: Math.sin(dir) * mag };
}

// ---------------------------------------------------------------------------------------------
// State / input / env
// ---------------------------------------------------------------------------------------------

export interface DiverInput {
  fwd: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  /** Dedicated vertical fin kicks — independent of look pitch, see VERTICAL_KICK_ACCEL. */
  ascend: boolean;
  descend: boolean;
  sprint: boolean;
  /** Look direction driving swim direction ("look-to-steer"), same angle convention as
   * `BoatState.h`: forward = (-sin(yaw), 0, -cos(yaw)) at pitch=0. */
  lookYaw: number;
  /** Radians, +up. Callers should clamp to a sane head-tilt range before passing it in; this
   * module clamps again defensively to [-1.3, 1.3]. */
  lookPitch: number;
}

/** Small local interface standing in for the real seafloor agent's `seafloorHeightAt(x,z)` —
 * see this file's header. Returns the world y of the seabed surface at (x,z); negative below the
 * datum. Must be pure/deterministic (no three.js, no DOM) to stay callable from both sim sides. */
export interface SeafloorSampler {
  heightAt(x: number, z: number): number;
}

export interface DiverEnv {
  /** Absolute sim time in seconds (never read from a clock here — see sim/boat.ts's env.t). */
  t: number;
  seafloor: SeafloorSampler;
  worldBounds: { x0: number; x1: number; z0: number; z1: number };
}

export type DiverEvent =
  | { type: 'blackout'; cause: 'airOut' | 'shallowWaterBlackout' }
  | { type: 'surfaced' }
  | { type: 'submerged' }
  | { type: 'groundHit' };

export interface DiverState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Facing/look direction, radians — same convention as `BoatState.h`. */
  yaw: number;
  pitch: number;
  /** Breath-hold budget remaining, 0..AIR_MAX. */
  air: number;
  /** Smoothed 0..1 exertion level — see EXERTION_RISE_RATE/EXERTION_FALL_RATE. */
  exertion: number;
  /** depth >= NARCOSIS_DEPTH. The renderer decides what "subtle warp, reticle sway" means. */
  narcosis: boolean;
  /** True from the instant air hits zero (or shallow-water blackout fires) until the caller
   * decides recovery is over (there is no "wake up" transition in this module — see
   * BLACKOUT_WAKE_DELAY and apps/client/src/entities/diver/controller.ts). */
  blackedOut: boolean;
  /** Seconds since blackedOut became true; 0 while conscious. */
  blackoutT: number;
  /** Events raised *this* step. Reset every call — same convention as `BoatState.events`. */
  events: DiverEvent[];
}

/** A fresh diver entering the water at (x,y,z) facing `yaw`, full air, conscious. */
export function createDiverState(x: number, y: number, z: number, yaw: number): DiverState {
  return {
    x, y, z,
    vx: 0, vy: 0, vz: 0,
    yaw, pitch: 0,
    air: AIR_MAX,
    exertion: 0,
    narcosis: false,
    blackedOut: false,
    blackoutT: 0,
    events: [],
  };
}

const NO_INPUT: DiverInput = {
  fwd: false, back: false, left: false, right: false, ascend: false, descend: false, sprint: false,
  lookYaw: 0, lookPitch: 0,
};

/** legacy-style inline helper: integrates kicks (if `allowKicks`), buoyancy/gravity, current, drag
 * and position + seafloor/world-bounds collision. Mutates `state` in place — `state` is always
 * `next` (the fresh copy stepDiver already made), never the caller's original. */
function integrateMotion(state: DiverState, input: DiverInput, env: DiverEnv, dt: number, allowKicks: boolean): void {
  if (allowKicks) {
    const fx = -Math.sin(state.yaw) * Math.cos(state.pitch);
    const fy = Math.sin(state.pitch);
    const fz = -Math.cos(state.yaw) * Math.cos(state.pitch);
    const rx = Math.cos(state.yaw);
    const rz = -Math.sin(state.yaw);

    let kx = 0, ky = 0, kz = 0;
    if (input.fwd) { kx += fx; ky += fy; kz += fz; }
    if (input.back) { kx -= fx; ky -= fy; kz -= fz; }
    if (input.right) { kx += rx; kz += rz; }
    if (input.left) { kx -= rx; kz -= rz; }
    const mag = Math.hypot(kx, ky, kz);
    if (mag > 1e-6) { kx /= mag; ky /= mag; kz /= mag; }

    const sprintK = input.sprint ? SPRINT_MULT : 1;
    const accel = SWIM_KICK_ACCEL * sprintK;
    state.vx += kx * accel * dt;
    state.vy += ky * accel * dt;
    state.vz += kz * accel * dt;

    if (input.ascend) state.vy += VERTICAL_KICK_ACCEL * sprintK * dt;
    if (input.descend) state.vy -= VERTICAL_KICK_ACCEL * sprintK * dt;
  }

  // Buoyancy only applies while genuinely submerged; above the surface it's plain gravity. The
  // controller is expected to stop driving stepDiver (switch back to "on the boat") well before
  // y strays far above 0 — this is a defensive fallback for the jump-off/breach moment, not the
  // primary exit path.
  if (state.y < 0) {
    const depth = Math.max(0, -state.y);
    state.vy += buoyancyAccel(depth) * dt;
  } else {
    state.vy -= 9.8 * dt;
  }

  const depthForCurrent = Math.max(0, -state.y);
  const cur = currentAt(state.x, state.z, depthForCurrent, env.t);
  state.vx += cur.x * dt;
  state.vz += cur.z * dt;

  const dragK = Math.max(0, 1 - WATER_DRAG * dt);
  state.vx *= dragK; state.vy *= dragK; state.vz *= dragK;

  state.x += state.vx * dt;
  state.y += state.vy * dt;
  state.z += state.vz * dt;

  const floorY = env.seafloor.heightAt(state.x, state.z);
  if (state.y < floorY + DIVER_RADIUS) {
    state.y = floorY + DIVER_RADIUS;
    if (state.vy < 0) state.vy = 0;
    state.events.push({ type: 'groundHit' });
  }

  const wb = env.worldBounds;
  state.x = clamp(state.x, wb.x0, wb.x1);
  state.z = clamp(state.z, wb.z0, wb.z1);
}

function triggerBlackout(state: DiverState, cause: 'airOut' | 'shallowWaterBlackout'): void {
  state.blackedOut = true;
  state.blackoutT = 0;
  state.air = 0;
  state.events.push({ type: 'blackout', cause });
}

/**
 * Advance the diver one fixed step. Pure: returns a new `DiverState`, never mutates `state`,
 * `input` or `env`. Matches `stepBoat`'s signature shape exactly (see sim/boat.ts).
 *
 * Per the doc's decision on blackout ("lose the fish and the trip, recover the gear"): this
 * module only raises the `blackout` event with its cause. It does not know about fish, trips or
 * gear — those systems (when they exist) hook the event; this module's job ends at physiology.
 */
export function stepDiver(state: DiverState, input: DiverInput, env: DiverEnv, dt: number): DiverState {
  const next: DiverState = { ...state, events: [] };
  const wasSubmerged = next.y < -SURFACE_EPS;

  if (next.blackedOut) {
    // Unconscious: no kicks, no breath-holding, pure momentum/buoyancy/drag/current/collision.
    next.blackoutT += dt;
    integrateMotion(next, NO_INPUT, env, dt, false);
    return next;
  }

  next.yaw = input.lookYaw;
  next.pitch = clamp(input.lookPitch, -1.3, 1.3);

  const depth = Math.max(0, -next.y);
  next.narcosis = depth >= NARCOSIS_DEPTH;

  const kicking = input.fwd || input.back || input.left || input.right || input.ascend || input.descend;
  const targetExertion = input.sprint ? 1 : kicking ? 0.45 : 0;
  const exertionRate = targetExertion > next.exertion ? EXERTION_RISE_RATE : EXERTION_FALL_RATE;
  next.exertion += (targetExertion - next.exertion) * Math.min(1, dt * exertionRate);

  const atSurface = depth <= SURFACE_EPS && next.vy >= -0.05;
  if (atSurface) {
    next.air = Math.min(AIR_MAX, next.air + SURFACE_REFILL_RATE * dt);
  } else {
    next.air = Math.max(0, next.air - airBurnRate(depth, next.exertion) * dt);
  }

  integrateMotion(next, input, env, dt, true);

  const newDepth = Math.max(0, -next.y);
  if (next.air <= 0) {
    triggerBlackout(next, 'airOut');
  } else if (
    newDepth > SURFACE_EPS && newDepth < SHALLOW_BLACKOUT_DEPTH &&
    next.air < AIR_MAX * SHALLOW_BLACKOUT_AIR_FRACTION &&
    next.vy > SHALLOW_BLACKOUT_MIN_ASCENT
  ) {
    triggerBlackout(next, 'shallowWaterBlackout');
  }

  const isSubmerged = next.y < -SURFACE_EPS;
  if (isSubmerged && !wasSubmerged) next.events.push({ type: 'submerged' });
  else if (!isSubmerged && wasSubmerged) next.events.push({ type: 'surfaced' });

  return next;
}
