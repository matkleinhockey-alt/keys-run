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
import { steadyCurrentAt, surgeAt } from '../world/current.js';

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

/** Base fin-kick acceleration (m/s^2) and the sprint multiplier on top of it. This is the MEAN over
 * a kick cycle — the thrust itself arrives in pulses (see `kickPulse`), whose average is exactly
 * this, so cruise speed and the exertion/air model are unchanged by the kick cadence. */
export const SWIM_KICK_ACCEL = 2.6;
export const SPRINT_MULT = 1.9;

/** Dedicated ascend/descend kick (m/s^2), independent of look pitch — doc lists "ascend/descend"
 * as its own control alongside look-to-steer, so looking straight up/down isn't the only way up. */
export const VERTICAL_KICK_ACCEL = 2.2;

/** Kicking backwards is a sculling motion, not a fin stroke: ~45% of forward thrust. */
export const BACK_KICK_FRACTION = 0.45;

/**
 * Drag, in the diver's own frame. The previous model was one linear `v *= 1 - 1.6 dt` on all axes:
 * terminal speed came out right (~1.6 m/s) but everything else felt wrong — stop kicking and you
 * were stationary within a second (a 1 m glide), and a strafe or a turn slid exactly as freely as
 * a forward swim because drag knew nothing about which way the body points.
 *
 *  - ALONG the body (streamlined): small linear term plus a quadratic one. The quadratic term is
 *    what sets a firm top speed; the small linear term is why a coast tails off slowly (~3 m of
 *    glide from cruise, vs 1 m) so swimming has momentum and stopping is something you do.
 *  - ACROSS the body (the diver presented sideways): ~5x the linear coefficient and a larger
 *    quadratic one. Sideslip dies in ~0.6 s, so changing heading carves a curve instead of
 *    skating, and strafing is a modest trim move (~1 m/s) rather than a second throttle.
 *
 * Applied implicitly (`v /= 1 + k dt`), unconditionally stable at the 30 Hz step, and acts on the
 * velocity RELATIVE to the water (see `waterVelocity`) so a diver who stops kicking ends up
 * drifting with the current rather than stuck against it.
 */
export const DRAG_AXIAL_LIN = 0.3;
export const DRAG_AXIAL_QUAD = 0.7;
export const DRAG_LATERAL_LIN = 1.5;
export const DRAG_LATERAL_QUAD = 1.2;
export const VERTICAL_LATERAL_DRAG_SCALE = 0.6;

/**
 * Fin-kick cadence. A fin stroke is a pulse, not a constant push: thrust arrives in a ~1.1 s
 * cycle (0.6 s sprinting) as a half-sine burst over a weak glide-phase floor, so the diver surges
 * with each kick and eases between them. `KICK_FLOOR + KICK_PEAK/4` = 1 so the cycle average is
 * exactly the nominal `SWIM_KICK_ACCEL` (mean of max(0,sin)^2 over a cycle is 1/4).
 */
export const KICK_PERIOD = 1.1;
export const KICK_PERIOD_SPRINT = 0.6;
const KICK_FLOOR = 0.35;
const KICK_PEAK = 4 * (1 - KICK_FLOOR);

/** Thrust multiplier at kick phase `phase` (0..1). Mean over a cycle is exactly 1. */
export function kickPulse(phase: number): number {
  const s = Math.max(0, Math.sin(phase * Math.PI * 2));
  return KICK_FLOOR + KICK_PEAK * s * s;
}

/**
 * Fraction of the water's velocity the diver actually feels. Real divers hanging off a reef wall
 * get pushed by the current but not by all of it — a body is a small sail and the bottom boundary
 * layer slows the water near the seabed. `COUPLING` is the open-water share; the factor ramps from
 * `BOUNDARY_MIN` at the floor to 1 by `BOUNDARY_H` metres above it, so hugging a rock to line up
 * a shot is calm and drifting up into open water gets you carried. Both numbers are tuning, not
 * hydrodynamics: at the Florida Current's 1.15 m/s a full-strength push would out-run the cruise
 * speed and make the offshore edge simply unswimmable.
 */
export const CURRENT_COUPLING = 0.75;
export const BOUNDARY_MIN = 0.3;
export const BOUNDARY_H = 4;

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
 * Velocity of the water the diver is in (m/s, horizontal), as the diver feels it.
 *
 * This used to be a private, made-up field (`0.05..0.15 m/s` pointing wherever a slow sine said) —
 * unrelated to world/current.ts, which models the Florida Current, the tide and wave surge and is
 * what the weeds, marine snow and fish already lean on. A diver in the same water as the weeds
 * must be pushed by the same flow, or the current is something you watch rather than something
 * that happens to you. So this samples the real field: steady (current + tide) plus surge, with
 * surge attenuated by the diver's OWN depth below the surface (orbital motion dies with depth
 * below the waves — world/current.ts's `surgeAt` is passed water depth for the weeds on the
 * floor; a diver mid-water wants distance from the surface), then scaled by `CURRENT_COUPLING`
 * and the near-floor boundary layer. `floorY` is the seabed height under the diver.
 *
 * Pure function of (x,y,z,t,floorY) — no RNG, no module state — so prediction replay and the
 * determinism tests stay exact.
 */
export function waterVelocity(x: number, y: number, z: number, t: number, floorY: number): { x: number; z: number } {
  const steady = steadyCurrentAt(x, z, t);
  const surge = surgeAt(x, z, t, Math.max(0, -y));
  const h = Math.max(0, y - floorY);
  const s = clamp(h / BOUNDARY_H, 0, 1);
  const boundary = BOUNDARY_MIN + (1 - BOUNDARY_MIN) * s * s * (3 - 2 * s);
  const k = CURRENT_COUPLING * boundary;
  return { x: (steady.vx + surge.vx) * k, z: (steady.vz + surge.vz) * k };
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
  /** Fin-kick cycle phase 0..1 (see `kickPulse`). Advances only while a kick input is held and
   * resets to 0 when idle, so every fresh kick starts on the rising edge of a stroke. The camera
   * reads it to surge/bob with the stroke; nothing else depends on it. */
  kickPhase: number;
  /** A swim/vertical kick input is held this step. */
  kicking: boolean;
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
    kickPhase: 0,
    kicking: false,
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

/** Integrates kicks (if `allowKicks`), buoyancy/gravity, drag against the moving water, and
 * position + seafloor/world-bounds collision. Mutates `state` in place — `state` is always
 * `next` (the fresh copy stepDiver already made), never the caller's original. */
function integrateMotion(state: DiverState, input: DiverInput, env: DiverEnv, dt: number, allowKicks: boolean): void {
  const cp = Math.cos(state.pitch);
  const fx = -Math.sin(state.yaw) * cp;
  const fy = Math.sin(state.pitch);
  const fz = -Math.cos(state.yaw) * cp;

  if (allowKicks) {
    const rx = Math.cos(state.yaw);
    const rz = -Math.sin(state.yaw);

    // Thrust direction. Forward and backward are weighted separately (a back-kick is a scull, not a
    // stroke) before the sum is normalised, so W+S cancel and S alone is gentle.
    let kx = 0, ky = 0, kz = 0;
    if (input.fwd) { kx += fx; ky += fy; kz += fz; }
    if (input.back) { kx -= fx * BACK_KICK_FRACTION; ky -= fy * BACK_KICK_FRACTION; kz -= fz * BACK_KICK_FRACTION; }
    if (input.right) { kx += rx; kz += rz; }
    if (input.left) { kx -= rx; kz -= rz; }
    const mag = Math.hypot(kx, ky, kz);
    // Normalise only when over unit length: a lone back-kick keeps its reduced magnitude instead
    // of being scaled back up to a full stroke.
    if (mag > 1) { kx /= mag; ky /= mag; kz /= mag; }

    const sprintK = input.sprint ? SPRINT_MULT : 1;
    const swimming = mag > 1e-6 || input.ascend || input.descend;
    state.kicking = swimming;
    if (swimming) {
      const period = input.sprint ? KICK_PERIOD_SPRINT : KICK_PERIOD;
      state.kickPhase = (state.kickPhase + dt / period) % 1;
    } else {
      state.kickPhase = 0;
    }
    const pulse = kickPulse(state.kickPhase);
    const accel = SWIM_KICK_ACCEL * sprintK * pulse;
    state.vx += kx * accel * dt;
    state.vy += ky * accel * dt;
    state.vz += kz * accel * dt;

    const vAccel = VERTICAL_KICK_ACCEL * sprintK * pulse;
    if (input.ascend) state.vy += vAccel * dt;
    if (input.descend) state.vy -= vAccel * dt;
  } else {
    state.kicking = false;
    state.kickPhase = 0;
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

  // Drag acts on the velocity RELATIVE TO THE WATER (see `waterVelocity`), split into the part
  // along the body and the part across it. The water's own velocity is added back afterwards, so
  // with no kicking the diver settles to the current's speed instead of being held still against
  // it, and a push from surge is felt as a push.
  const floorHere = env.seafloor.heightAt(state.x, state.z);
  const w = waterVelocity(state.x, state.y, state.z, env.t, floorHere);
  const rvx = state.vx - w.x, rvy = state.vy, rvz = state.vz - w.z;
  const par = rvx * fx + rvy * fy + rvz * fz;
  const px = rvx - par * fx, py = rvy - par * fy, pz = rvz - par * fz;
  const kPar = DRAG_AXIAL_LIN + DRAG_AXIAL_QUAD * Math.abs(par);
  const kPerp = DRAG_LATERAL_LIN + DRAG_LATERAL_QUAD * Math.hypot(px, py, pz);
  const dPar = 1 / (1 + kPar * dt);
  const dPerpH = 1 / (1 + kPerp * dt);
  // Across-body motion that is VERTICAL is damped less than sideways slip: floating up or
  // sinking is not the body being dragged broadside the way a strafe is, and at the full lateral
  // coefficient a duck-dive from the surface crawled at ~0.4 m/s.
  const dPerpV = 1 / (1 + kPerp * VERTICAL_LATERAL_DRAG_SCALE * dt);
  state.vx = w.x + par * dPar * fx + px * dPerpH;
  state.vy = par * dPar * fy + py * dPerpV;
  state.vz = w.z + par * dPar * fz + pz * dPerpH;

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
