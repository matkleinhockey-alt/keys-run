/**
 * `applyBoatVisuals(state, model, ctx)`: every three.js/DOM side effect legacy's `updateBoat`
 * used to perform directly — group transform, prop/flag/outboard/wheel animation, wake ring
 * sync into the water shader, wake/spray particles, and collision/slam/ventilation toasts.
 *
 * This is the presentation half of the split described in packages/shared/src/sim/boat.ts's
 * doc comment and docs/ARCHITECTURE.md requirement 3. `stepBoat` (the pure half) returns a new
 * `BoatState` plus a list of `events` for this tick; this module is what actually plays them —
 * toasts with their own debounce timers (legacy's `collideMsgT`/`slamT`/`TRIM.msgT`, which were
 * pure message-throttling, never physics).
 */
import type { BoatState, SimEvent } from '@keysrun/shared/sim/boat';
import { waveHBase } from '@keysrun/shared/waves';
import type { BoatModel } from './model.js';
import type { ParticleSystem } from '../../world/particles.js';
import type { WaterHandles } from '../../world/water.js';
import { rand } from '../../core/math.js';
import { toast } from '../../ui/toast.js';

export interface VisualsHull { len: number; beam: number; topMs: number }

export interface VisualsCtx {
  t: number;
  dt: number;
  todK: number;
  sw: number;
  ch: number;
  /** Wave amplitude at the boat's current position (legacy `ampAt(boat.x,boat.z)`), for spray bobbing. */
  amp: number;
  hull: VisualsHull;
  particles: ParticleSystem;
  water: WaterHandles;
}

const msgCooldown = { collide: -99, slam: -99, vent: -99, autoChase: -99 };
const SLAM_MESSAGES = ['Stuffed it! Trim up and ease off a little.', 'Big air — hang on!', 'That one hurt. Back off in the slop.'];

/** Combines the boat's own wake (physics ring) with the base wave sum — the same `waveH` legacy
 * used for cosmetic water-height queries (spray bobbing, dock-boat bobbing). See
 * packages/shared/src/sim/boat.ts's doc comment for why the wake ring lives in `BoatState`. */
export function sampleWaterHeight(state: BoatState, x: number, z: number, t: number, amp: number, sw: number, ch: number): number {
  return waveHBase(x, z, t, amp, sw, ch) + wakeHeightFor(state, x, z, t);
}

function wakeHeightFor(state: BoatState, x: number, z: number, t: number): number {
  const ring = state.wakeRing;
  const WAKE_N = ring.length / 4;
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

/**
 * `state` is the (possibly render-interpolated) display state used for the visual transform
 * and cosmetic spin rates; `events` are the authoritative events from whichever *physics* steps
 * actually ran this tick (0-5 of them — see docs/ARCHITECTURE.md requirement 2's accumulator),
 * passed separately so interpolation never duplicates or drops a toast. See game/world.ts.
 */
export function applyBoatVisuals(state: BoatState, model: BoatModel, ctx: VisualsCtx, events: readonly SimEvent[]): void {
  const { t, dt } = ctx;

  model.props.forEach((p) => { p.rotation.z += dt * (state.thr * 45 + state.speed * 0.8); });
  model.flags.forEach((fl) => fl.update(t, Math.abs(state.speed) + 4));
  model.outboards.forEach((o) => { o.rotation.x = -0.02 - state.trimV * 0.32; });
  model.wheel.rotation.z = -state.steer * 2.2;
  if (model.tower) model.tower.wheel.rotation.z = -state.steer * 2.2;

  // cockpit mood lighting dims in at sunset (legacy index.html:3289)
  model.cabin.visible = ctx.todK > 0.5;
  const k = Math.max(0, Math.min(1, (ctx.todK - 0.5) * 2));
  model.cabinLight.intensity = 0.9 * k;
  model.cabinLight2.intensity = 0.8 * k;

  const g = model.group;
  g.position.set(state.x, state.y, state.z);
  g.rotation.set(state.pitch, state.h, state.roll, 'YXZ');

  const fx = -Math.sin(state.h), fz = -Math.cos(state.h), rx = Math.cos(state.h), rz = -Math.sin(state.h);
  applySpray(state, ctx, fx, fz, rx, rz);
  ctx.water.syncWakeUniform(state.wakeRing);

  for (const ev of events) {
    switch (ev.type) {
      case 'beached':
        if (t - msgCooldown.collide > 3) { msgCooldown.collide = t; toast('Beached! Back off with S.'); }
        break;
      case 'bumpedPiling':
        if (t - msgCooldown.collide > 2) { msgCooldown.collide = t; toast(ev.rig ? 'Bumped the rig leg!' : 'Bumped a bridge piling!'); }
        break;
      case 'bumpedDock':
        if (t - msgCooldown.collide > 2.5) { msgCooldown.collide = t; toast('Easy — you bumped a boat or the dock.'); }
        break;
      case 'chartEdge':
        if (t - msgCooldown.collide > 4) { msgCooldown.collide = t; toast('Edge of the chart — turn back toward Marathon.'); }
        break;
      case 'slam':
        if (ev.k > 0.6 && t - msgCooldown.slam > 6) {
          msgCooldown.slam = t;
          toast(SLAM_MESSAGES[Math.floor(Math.random() * SLAM_MESSAGES.length)]);
        }
        slamSpray(state, ctx, ev.k, fx, fz, rx, rz);
        break;
      case 'propVentilation':
        if (t - msgCooldown.vent > 5) { msgCooldown.vent = t; toast('Relax, Chum Lee — your props are out of the water!'); }
        break;
      case 'autoChaseShallow':
        if (t - msgCooldown.autoChase > 5) { msgCooldown.autoChase = t; toast('Auto-chase stopped: shallow water. Steer it yourself.'); }
        break;
      default:
        break;
    }
  }
}

/** legacy `slam`'s spray loop (index.html:3891), minus `AUD.slam`/`cam.shake` (audio/camera-shake
 * side effects applied by the caller — see entities/camera.ts). */
function slamSpray(state: BoatState, ctx: VisualsCtx, k: number, fx: number, fz: number, rx: number, rz: number): void {
  const L = ctx.hull.len * 0.5, B = ctx.hull.beam * 0.5;
  for (let i = 0; i < Math.round(14 + k * 30); i++) {
    const sgn = Math.random() < 0.5 ? -1 : 1, o = rand(-0.3, 0.5) * L;
    ctx.particles.spawnP(
      state.x + fx * o + rx * B * sgn, 0.2, state.z + fz * o + rz * B * sgn,
      rx * sgn * rand(2, 6) + fx * state.speed * 0.3, rand(2, 6) * k + 1, rz * sgn * rand(2, 6) + fz * state.speed * 0.3,
      rand(0.6, 1.2), rand(0.5, 1.2), 0.85, true,
    );
  }
}

let wakeAcc = 0;

/** legacy's wake-trail + bow/stern spray (index.html:3973-3983). `wakeAcc` is a presentation-only
 * cadence accumulator — unlike `state.wakeTimer` (physics, in `BoatState`), it never feeds back
 * into the simulation, so it's module-local state here rather than part of `BoatState`. */
function applySpray(state: BoatState, ctx: VisualsCtx, fx: number, fz: number, rx: number, rz: number): void {
  const sp = Math.abs(state.speed);
  if (sp <= 1.5) return;
  const L = ctx.hull.len * 0.5, B = ctx.hull.beam * 0.5;
  wakeAcc += ctx.dt * sp * 1.6;
  while (wakeAcc > 1) {
    wakeAcc--;
    const sx = state.x - fx * L * 1.05, sz = state.z - fz * L * 1.05;
    for (const sgn of [-1, 1]) {
      ctx.particles.spawnP(
        sx + rx * B * 0.8 * sgn, 0.1, sz + rz * B * 0.8 * sgn,
        rx * sgn * (1.2 + sp * 0.07) - fx * sp * 0.15, 0, rz * sgn * (1.2 + sp * 0.07) - fz * sp * 0.15,
        rand(2.5, 4.5), rand(1.2, 2), 0.55, false, ctx.amp,
      );
    }
    ctx.particles.spawnP(sx + rand(-0.4, 0.4), 0.1, sz + rand(-0.4, 0.4), -fx * sp * 0.25, 0, -fz * sp * 0.25, rand(2, 3.5), rand(1.5, 2.4), 0.7, false, ctx.amp);
  }
  const f = sp / ctx.hull.topMs;
  if (f > 0.3 && Math.random() < ctx.dt * sp * 0.8) {
    for (const sgn of [-1, 1]) {
      const bx = state.x + fx * L * 0.35 + rx * B * sgn, bz = state.z + fz * L * 0.35 + rz * B * sgn;
      ctx.particles.spawnP(bx, 0.3, bz, rx * sgn * rand(3, 6), rand(2, 4), rz * sgn * rand(3, 6), rand(0.5, 0.9), rand(0.4, 0.8), 0.8, true);
    }
  }
}
