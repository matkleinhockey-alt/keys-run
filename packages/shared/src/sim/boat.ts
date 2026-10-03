/**
 * Pure boat physics: the 15-point buoyancy integrator, trim curve, prop ventilation, throttle
 * lag, turn rate, wake generation and collision resolution.
 *
 * Ported faithfully from legacy/index.html's `updateBoat` (3897-3984), `autoChaseControl`
 * (3869-3888), `slam` (3890-3892) and `dockCollide` (1727-1737) — see docs/ARCHITECTURE.md's
 * Phase 0 scope table. Every magic number and evaluation order is preserved exactly; this is
 * verified against an independent oracle extracted straight from legacy/index.html in
 * apps/client/test/boat-trajectory.test.ts (tolerance 1e-9 on x/z/heading/speed, 1e-6 on
 * y/pitch/roll — see that file for the one known, documented exception).
 *
 * This module is **pure**: plain `{x,y,z}` numbers, never `THREE.Vector3`/`THREE.Vector4`, no
 * DOM, no `Date.now()`/`performance.now()` (callers pass `env.t`). Per docs/ARCHITECTURE.md
 * ("must never import three.js"), the three.js/DOM side effects legacy's `updateBoat` had —
 * `boat.model.props/flags/wheel` mutation, `emitWake`'s *visual* spray, and `toast()` — are
 * removed. The wake *ring buffer* itself is NOT removed: legacy's buoyancy integrator reads
 * `waveH = waveHBase + wakeH`, i.e. a boat's own wake genuinely feeds back into its own
 * buoyancy a few hundred ms later, and dropping that would be a real behavioural regression,
 * not a cleanup. So `wakeRing` (plain numbers, see `WAKE_N`) travels inside `BoatState` instead
 * of legacy's module-level `THREE.Vector4` array — same self-consistent single-boat behaviour,
 * still zero three.js. Collisions, slams and ventilation that legacy reported via `toast()`/
 * `AUD`/particle spray are instead reported as `state.events`, which the presentation layer
 * (apps/client/src/entities/boat/visuals.ts) turns into toasts/audio/particles with its own
 * debounce timers (legacy's `collideMsgT`/`acMsgT`/`slamT`/`TRIM.msgT` were purely
 * message-throttling, not physics, so they move out too).
 */

import { depthAt, landH } from '../world/depth.js';
import { waveHBase, waveSlope } from '../waves/index.js';
import { ampAt, depthFast } from './depth-grid.js';
import { clamp, lerp } from '../internal/math.js';
import { SPEED_SCALE } from '../content/boats.js';

/** Ring buffer size for recent wake emissions (legacy `WAKE_N`, index.html:450). */
export const WAKE_N = 72;

export interface BoatHull {
  len: number;
  beam: number;
  top: number;
  accel: number;
  turn: number;
  draft: number;
  cat?: boolean;
}

export interface BoatInput {
  fwd: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  trimUp: boolean;
  trimDn: boolean;
}

export interface Piling {
  x: number;
  z: number;
  /** Old Seven Mile Bridge pilings are fatter and use a larger default radius (legacy `p.old`). */
  old?: boolean;
  /** Explicit override radius (e.g. a future rig leg); falls back to `old ? 1.3 : .8` (legacy `p.r`). */
  r?: number;
}

export interface DockRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface FightTarget {
  x: number;
  z: number;
  running: boolean;
}

export interface BoatEnv {
  /** Absolute sim time in seconds (legacy's closure-captured `t`; never read from a clock here). */
  t: number;
  hull: BoatHull;
  /** Live sea-state scalars (legacy module-level `SW`/`CH`, ramped toward SEA_STATES client-side). */
  sw: number;
  ch: number;
  worldBounds: { x0: number; x1: number; z0: number; z1: number };
  /** Bridge/rig-leg pilings, flattened (legacy `PGRID`); a plain array is fine at this scale. */
  pilings: readonly Piling[];
  dockRects: readonly DockRect[];
  /** legacy `game.running && F.state!=='caught'`. Always true in Phase 0 (no fishing state machine yet). */
  canDrive: boolean;
  /** legacy `F.state==='fight'`. Always false until Phase 0b's fishing lands — see autoChaseControl. */
  fightActive: boolean;
  fightTarget: FightTarget | null;
  /** legacy `lineOut()`. Always false until fishing lands. */
  lineOut: boolean;
  /** legacy `LUIGI.on`; only gates a toast message, kept for interface completeness. */
  luigiOn: boolean;
}

export type SimEvent =
  | { type: 'beached' }
  | { type: 'bumpedPiling'; rig: boolean }
  | { type: 'bumpedDock' }
  | { type: 'chartEdge' }
  | { type: 'slam'; k: number }
  | { type: 'propVentilation' }
  | { type: 'autoChaseShallow' };

export interface BoatState {
  x: number;
  z: number;
  /** Heading, radians (legacy `boat.h`). */
  h: number;
  speed: number;
  thr: number;
  steer: number;
  y: number;
  pitch: number;
  roll: number;
  vy: number;
  vp: number;
  vr: number;
  dvx: number;
  dvz: number;
  air: boolean;
  gear: 'D' | 'N' | 'R';
  gearRev: number;
  engineOn: boolean;
  trimMode: boolean;
  trimV: number;
  trimVent: number;
  autoChaseEnabled: boolean;
  autoOn: boolean;
  autoMode: string;
  /** legacy `boat.wakeT`: accumulator gating how often a new wake ring is emitted. */
  wakeTimer: number;
  /** Flat [x,z,t,packed]×WAKE_N ring (legacy module-level `wakeP: THREE.Vector4[]`, plain here). */
  wakeRing: Float64Array;
  wakeRingIndex: number;
  /** Collision/slam/ventilation events raised *this* step. Reset every call. */
  events: SimEvent[];
}

/** A fresh boat at rest at (x,z,h) — legacy's initial `const boat={...}` plus `unstick()`'s reset. */
export function createBoatState(x: number, z: number, h: number): BoatState {
  const wakeRing = new Float64Array(WAKE_N * 4);
  for (let i = 0; i < WAKE_N; i++) wakeRing[i * 4 + 2] = -999; // t = -999, matching THREE.Vector4(0,0,-999,0)
  return {
    x, z, h,
    speed: 0, thr: 0, steer: 0,
    y: 0, pitch: 0, roll: 0,
    vy: 0, vp: 0, vr: 0,
    dvx: 0, dvz: 0,
    air: false,
    gear: 'D', gearRev: 0,
    engineOn: true,
    trimMode: false, trimV: 0.2, trimVent: 0,
    autoChaseEnabled: true, autoOn: false, autoMode: '',
    wakeTimer: 0,
    wakeRing, wakeRingIndex: 0,
    events: [],
  };
}

function wrapAngle(a: number): number {
  return ((a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

/** legacy `wakeH` (index.html:454-460), over a plain [x,z,t,packed]×N ring instead of `THREE.Vector4[]`. */
function wakeHeight(ring: Float64Array, x: number, z: number, t: number): number {
  let h = 0;
  for (let i = 0; i < WAKE_N; i++) {
    const o = i * 4, packed = ring[o + 3];
    if (packed <= 0) continue;
    const age = t - ring[o + 2];
    if (age < 0.8 || age > 22) continue;
    const cq = Math.floor(packed / 10), c = cq / 10, A = packed - cq * 10;
    const R = c * age + 1.2, wd = 1.6 + age * 0.3;
    const dx = x - ring[o], dz = z - ring[o + 1];
    if (Math.abs(dx) > R + wd * 3 || Math.abs(dz) > R + wd * 3) continue;
    const dr = Math.hypot(dx, dz) - R;
    if (Math.abs(dr) > wd * 3) continue;
    h += A * Math.exp(-age / 9) / (1 + R * 0.03) * Math.exp(-dr * dr / (wd * wd)) * Math.cos(2.4 / wd * dr);
  }
  return h;
}

/** legacy `waveH` (index.html:442-444): the pure wave sum plus this boat's own recent wake. */
function waveHeightWithWake(ring: Float64Array, x: number, z: number, t: number, amp: number, sw: number, ch: number): number {
  return waveHBase(x, z, t, amp, sw, ch) + wakeHeight(ring, x, z, t);
}

/** legacy `emitWake` (index.html:451-453), writing into a plain ring instead of `THREE.Vector4[]`. */
function emitWakeInto(ring: Float64Array, index: number, x: number, z: number, v: number, len: number, t: number): number {
  if (v < 2) return index;
  const A = clamp(len / 10, 0.35, 1.3) * (0.18 + 0.5 * Math.exp(-(((v - 8) / 7) ** 2)) + 0.12 * Math.min(v / 25, 1));
  const c = Math.max(1.5, 0.34 * v);
  const o = index * 4;
  ring[o] = x; ring[o + 1] = z; ring[o + 2] = t; ring[o + 3] = Math.round(c * 10) * 10 + Math.min(9.9, A);
  return (index + 1) % WAKE_N;
}

/** legacy `autoChaseControl` (index.html:3869-3888). Always returns null until fishing (Phase 0b) lands. */
function autoChaseControl(
  state: BoatState,
  input: BoatInput,
  env: BoatEnv,
  topMs: number,
): { thr: number; steer: number; autoMode: string } | null {
  if (!state.autoChaseEnabled || !env.canDrive || !env.fightActive || input.fwd || input.left || input.right) {
    return null;
  }
  const target = env.fightTarget;
  if (!target) return null;
  const dx = target.x - state.x, dz = target.z - state.z, dist = Math.hypot(dx, dz);
  const want = Math.atan2(-dx, -dz);
  const diff = wrapAngle(want - state.h), diffStern = wrapAngle(want - (state.h + Math.PI));
  let thr = 0, steer = 0, autoMode: string;
  if (!(Math.abs(diff) < 0.9 && dist > 90)) {
    steer = clamp(-diffStern * 2.2, -1, 1);
    const v = clamp((dist - 14) * 0.22 + (target.running ? 2.5 : 0), 0, 6) * (Math.abs(diffStern) > 0.8 ? 0.35 : 1);
    thr = -Math.min(0.5, v / topMs);
    autoMode = thr < 0 ? 'Backing down on the fish' : 'Holding the stern on the fish';
  } else {
    steer = clamp(diff * 2.5, -1, 1);
    const v = clamp((dist - 60) * 0.3 + (target.running ? 3 : 0), 0, 12) * (Math.abs(diff) > 1 ? 0.4 : 1);
    thr = v / topMs;
    autoMode = 'Running up on the fish';
  }
  const fx = -Math.sin(state.h), fz = -Math.cos(state.h), dir = thr < 0 ? -1 : 1;
  const ahead = depthFast(state.x + fx * 16 * dir, state.z + fz * 16 * dir);
  if (ahead < env.hull.draft + 0.35 || landH(state.x + fx * 12 * dir, state.z + fz * 12 * dir) > -0.3) {
    thr = 0;
    autoMode = 'Stopped — shallow water';
  }
  return { thr, steer, autoMode };
}

/** legacy `dockCollide` (index.html:1727-1737), minus the `boat.speed`/`toast` side effects. */
function resolveDockCollision(
  nx: number, nz: number, fx: number, fz: number, hull: BoatHull, dockRects: readonly DockRect[],
): { nx: number; nz: number; hit: boolean } {
  let hit = false;
  for (const r of dockRects) {
    if (Math.abs(nx - (r.x0 + r.x1) / 2) > 40 || Math.abs(nz - (r.z0 + r.z1) / 2) > 40) continue;
    for (const off of [0, hull.len * 0.42, -hull.len * 0.42]) {
      const px = nx + fx * off, pz = nz + fz * off, m = hull.beam * 0.5;
      if (px > r.x0 - m && px < r.x1 + m && pz > r.z0 - m && pz < r.z1 + m) {
        const dl = px - (r.x0 - m), dr = (r.x1 + m) - px, dn = pz - (r.z0 - m), ds = (r.z1 + m) - pz;
        const mn = Math.min(dl, dr, dn, ds);
        if (mn === dl) nx -= dl; else if (mn === dr) nx += dr; else if (mn === dn) nz -= dn; else nz += ds;
        hit = true;
      }
    }
  }
  return { nx, nz, hit };
}

/**
 * Advance the boat one fixed step. Pure: returns a new `BoatState`, never mutates `state`,
 * `input` or `env`. `dt` should be the fixed 30 Hz timestep (1/30) — see docs/ARCHITECTURE.md
 * requirement 2; the function itself is timestep-agnostic (legacy ran it at render rate).
 */
export function stepBoat(state: BoatState, input: BoatInput, env: BoatEnv, dt: number): BoatState {
  const t = env.t;
  const hull = env.hull;
  const topMs = hull.top * 0.5144 * SPEED_SCALE;
  const canDrive = env.canDrive;

  const next: BoatState = {
    ...state,
    wakeRing: state.wakeRing.slice(),
    events: [],
  };

  let tt = (canDrive && next.engineOn)
    ? (next.gear === 'D' ? (input.fwd ? 1 : 0)
      : next.gear === 'R' ? ((input.fwd || (input.back && !env.lineOut)) ? -0.35 : 0)
      : 0)
    : 0;
  next.gearRev = lerp(next.gearRev, (next.gear === 'N' && next.engineOn && input.fwd) ? 1 : 0, Math.min(1, dt * (input.fwd ? 2.2 : 1.4)));
  if (next.trimMode && canDrive && !input.fwd && !input.back) tt = next.thr;

  const ac = autoChaseControl(next, input, env, topMs);
  if (ac) tt = ac.thr;
  next.thr += (tt - next.thr) * Math.min(1, dt * 2.5);

  if (input.trimUp) next.trimV = Math.min(1, next.trimV + dt * 0.35);
  if (input.trimDn) next.trimV = Math.max(0, next.trimV - dt * 0.35);
  const fr = Math.abs(next.speed) / topMs;
  const opt = fr < 0.35 ? 0.15 : 0.15 + 0.55 * Math.min(1, (fr - 0.35) / 0.5);
  const off = next.trimV - opt;
  next.trimVent = fr > 0.4 && next.trimV > 0.82 ? Math.min(1, (next.trimV - 0.82) / 0.18 * (fr - 0.4) / 0.4 * 1.6) : 0;
  const trimK = (1 + 0.06 - 0.35 * off * off) * (1 - 0.25 * next.trimVent);
  const target = next.thr * topMs * trimK * (next.thr > 0 ? 1 : 1);
  const holeShot = fr < 0.4 && next.thr > 0.5 ? 1 + 0.45 * (0.3 - next.trimV) : 1;
  next.speed += (target - next.speed) * dt * (next.thr === 0 ? hull.accel * 0.5 : hull.accel * holeShot);
  if (next.trimVent > 0.2 && !env.luigiOn) next.events.push({ type: 'propVentilation' });

  const d = depthAt(next.x, next.z);
  if (d < hull.draft) next.speed = clamp(next.speed, -1.2, 1.5);

  const st = ac ? ac.steer : canDrive ? (input.left ? 1 : input.right ? -1 : 0) : 0;
  next.steer += (st - next.steer) * Math.min(1, dt * 4);
  if (ac) { next.autoOn = true; next.autoMode = ac.autoMode; } else { next.autoOn = false; }

  const f = Math.abs(next.speed) / topMs;
  next.h += hull.turn * next.steer * (0.3 + Math.min(1, Math.abs(next.speed) / 8) * 0.9) * (1 - 0.35 * f) * (1.15 - 0.35 * next.trimV) * (next.speed < -0.2 ? -1 : 1) * dt;
  const fx = -Math.sin(next.h), fz = -Math.cos(next.h);
  let nx = next.x + fx * next.speed * dt, nz = next.z + fz * next.speed * dt;

  // land collisions: beaches, banks and creek walls
  for (const off2 of [0, hull.len * 0.42, -hull.len * 0.32]) {
    const px = nx + fx * off2, pz = nz + fz * off2, hn = landH(px, pz);
    if (hn > 0.15 && hn >= landH(next.x + fx * off2, next.z + fz * off2) - 0.01) {
      nx = next.x; nz = next.z;
      next.speed *= ((off2 >= 0) === (next.speed >= 0)) ? 0.1 : 0.6;
      next.events.push({ type: 'beached' });
      break;
    }
  }
  // piling collisions
  for (const p of env.pilings) {
    for (const off2 of [0, hull.len * 0.4, -hull.len * 0.4]) {
      const px = nx + fx * off2, pz = nz + fz * off2, dx = px - p.x, dz = pz - p.z, dd = Math.hypot(dx, dz);
      const r = hull.beam * 0.5 + (p.r || (p.old ? 1.3 : 0.8));
      if (dd < r && dd > 0.001) {
        nx += dx / dd * (r - dd); nz += dz / dd * (r - dd);
        next.speed *= 0.4;
        next.events.push({ type: 'bumpedPiling', rig: !!p.r });
      }
    }
  }
  {
    const res = resolveDockCollision(nx, nz, fx, fz, hull, env.dockRects);
    nx = res.nx; nz = res.nz;
    if (res.hit) { next.speed *= 0.3; next.events.push({ type: 'bumpedDock' }); }
  }
  const wb = env.worldBounds;
  next.x = clamp(nx, wb.x0, wb.x1); next.z = clamp(nz, wb.z0, wb.z1);
  if (nx < wb.x0 + 1 || nx > wb.x1 - 1 || nz < wb.z0 + 1 || nz > wb.z1 - 1) {
    next.speed *= 0.9;
    next.events.push({ type: 'chartEdge' });
  }

  // ride on the waves
  // (legacy also computed L=hull.len*.5, B=hull.beam*.5 here, but only to pass to the
  // presentation-side slam() spray; stepBoat reports {type:'slam',k} instead, see below)
  const amp = ampAt(next.x, next.z), rx = Math.cos(next.h), rz = -Math.sin(next.h);
  const plane = 0.11 * Math.sin(Math.min(f * 2.6, 1) * Math.PI) * (1.25 - 0.5 * next.trimV) + 0.035 * f + (next.trimV - 0.3) * 0.11 * Math.min(1, f * 2) + next.trimVent * 0.05 * Math.sin(t * 9);
  const sl = waveSlope(next.x, next.z, t, amp, env.sw, env.ch), along = sl[0] * fx + sl[1] * fz, beamSl = sl[0] * rx + sl[1] * rz;
  if (!next.air) {
    next.speed -= along * 9.8 * 0.5 * dt;
    next.dvx = next.dvx - sl[0] * 9.8 * 0.22 * dt;
    next.dvz = next.dvz - sl[1] * 9.8 * 0.22 * dt;
    if (f < 0.25) next.h += beamSl * 0.35 * dt * (1 - f * 4);
  }
  next.dvx *= 1 - Math.min(1, dt * 0.7); next.dvz *= 1 - Math.min(1, dt * 0.7);
  next.x += next.dvx * dt; next.z += next.dvz * dt;

  // buoyancy: 15 points under the hull
  const Dk = (0.45 + hull.len * 0.035) * (hull.cat ? 0.85 : 1);
  const ride = Dk * (1 - 0.55 * Math.min(1, f * 1.6) * (0.8 + 0.4 * next.trimV));
  const NX = [-0.42, 0, 0.42], NZ = [-0.46, -0.22, 0.02, 0.26, 0.46];
  const k = 9.8 / (15 * Dk), Ip = hull.len * hull.len / 12 * 1.15, Ir = hull.beam * hull.beam / 12 * (hull.cat ? 2.4 : 1.7);
  let sz2 = 0, sx2 = 0;
  NZ.forEach((a) => { sz2 += 3 * (a * hull.len) ** 2; });
  NX.forEach((a) => { sx2 += 5 * (a * hull.beam) ** 2; });
  const wH = Math.sqrt(9.8 / Dk), wP = Math.sqrt(k * sz2 / Ip), wR = Math.sqrt(k * sx2 / Ir), zeta = 0.3;
  let wet = 0;
  const SUB = 3, hdt = dt / SUB;
  for (let it = 0; it < SUB; it++) {
    let Fy = 0, Tp = 0, Tr = 0;
    wet = 0;
    const spn = Math.sin(next.pitch), srn = Math.sin(next.roll), tt2 = t - dt + hdt * (it + 1);
    for (const ax of NX) {
      for (const az of NZ) {
        const px = ax * hull.beam, pz = az * hull.len;
        const wx = next.x + fx * (-pz) + rx * px, wz = next.z + fz * (-pz) + rz * px;
        const yb = next.y + (-pz) * spn + px * srn - ride;
        const sbm = clamp(waveHeightWithWake(next.wakeRing, wx, wz, tt2, amp, env.sw, env.ch) - yb, 0, Dk * 2.4);
        if (sbm > 0) wet++;
        const Fi = k * sbm;
        Fy += Fi; Tp += Fi * (-pz); Tr += Fi * px;
      }
    }
    const inW = wet > 0 ? 1 : 0.15;
    next.vy += (Fy - 9.8 - 2 * zeta * wH * next.vy * inW) * hdt; next.y += next.vy * hdt;
    next.vp += (Tp / Ip + plane * wP * wP * (wet ? 1 : 0) - (wet ? 0 : 0.5) - 2 * zeta * wP * next.vp * inW) * hdt; next.pitch += next.vp * hdt;
    next.vr += (Tr / Ir + next.steer * f * (hull.cat ? 0.05 : 0.16) * wR * wR * (wet ? 1 : 0) - 2 * zeta * wR * next.vr * inW) * hdt; next.roll += next.vr * hdt;
  }
  next.pitch = clamp(next.pitch, -0.6, 0.75);
  next.roll = clamp(next.roll, -0.7, 0.7);
  const wasAir = next.air;
  next.air = wet === 0;
  if (wasAir && !next.air && next.vy < -2.2) {
    const slamK = clamp(-next.vy / 6, 0, 1);
    next.speed *= 1 - 0.06 * slamK;
    next.events.push({ type: 'slam', k: slamK });
  }
  if (d < hull.draft && next.y < -0.15) { next.y = -0.15; next.vy = Math.max(0, next.vy); }

  next.wakeTimer += dt;
  if (next.wakeTimer > 0.35 && Math.abs(next.speed) > 2) {
    next.wakeTimer = 0;
    next.wakeRingIndex = emitWakeInto(next.wakeRing, next.wakeRingIndex, next.x - fx * hull.len * 0.5, next.z - fz * hull.len * 0.5, Math.abs(next.speed), hull.len, t);
  }

  return next;
}
