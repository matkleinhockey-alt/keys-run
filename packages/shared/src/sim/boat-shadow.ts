/**
 * The server's 2-DOF "shadow" boat model: x, z, heading, speed only. Per docs/ARCHITECTURE.md's
 * authority model ("A. The boat is client-simulated. The diver is server-simulated"), the client
 * owns the full 15-point buoyancy integrator (`stepBoat` in `./boat.ts`); the server never tries
 * to reproduce y/pitch/roll/vy/vp/vr — reproducing a stiff oscillator's *phase* across two
 * machines is the hardest possible prediction target and isn't competitively meaningful anyway.
 * What the server *does* need is a cheap, independent estimate of where a legitimate boat could
 * plausibly be, to validate the client's self-reported x/z/h/speed against (see
 * apps/sim/src/world/envelope.ts).
 *
 * This reuses `stepBoat`'s throttle-lag, trim-curve and turn-rate formulas verbatim (same
 * constants, same evaluation order) but deliberately drops:
 *   - buoyancy (the 15-point integrator, 3 substeps/tick) — the entire reason this model is cheap
 *   - wake generation/feedback (`wakeRing`) — wake only feeds *heave*, which the shadow doesn't track
 *   - collision resolution (land/piling/dock) — collisions legitimately move the client's hull by
 *     metres in ways the shadow can't predict; envelope.ts's `landH`/`depthAt` checks catch the
 *     cheat case (driving *through* land) without the shadow needing to model bounce physics
 *   - `autoChaseControl` — gated on fight state, which doesn't exist until Phase 3
 *   - live trim tracking — the shadow uses a fixed `trimV = 0.2` (stepBoat's own initial/rest
 *     value) rather than integrating trimUp/trimDn. Trim shifts top speed by single-digit
 *     percent (`trimK`'s `off*off` term is small near the optimum); modelling it exactly would
 *     require carrying trimV as additional per-player server state for a correction that's
 *     already inside the envelope's speed headroom (hull.top * 1.12). This is the one place this
 *     module is an approximation rather than a subset of `stepBoat`'s own formulas — flagged in
 *     the Phase 2 handoff report.
 *
 * One `waveSlope` call per step (for surge drag) is kept, per docs/ARCHITECTURE.md's explicit
 * "plus one waveSlope call for surge". Target cost: ~1 µs/player/tick — measured in
 * apps/sim/test/load.ts.
 */
import type { BoatHull, BoatInput } from './boat.js';
import { waveSlope } from '../waves/index.js';
import { ampAt } from './depth-grid.js';
import { SPEED_SCALE } from '../content/boats.js';

export interface ShadowBoatState {
  x: number;
  z: number;
  /** Heading, radians, wrapped to (-pi, pi]. */
  h: number;
  speed: number;
  thr: number;
  steer: number;
  gear: 'D' | 'N' | 'R';
}

export interface ShadowEnv {
  /** Absolute sim time in seconds — same clock stepBoat's `env.t` uses. */
  t: number;
  hull: BoatHull;
  sw: number;
  ch: number;
}

/** stepBoat's rest trim value (index.html's initial `trimV:.2`) — see the module doc above. */
const SHADOW_TRIM_V = 0.2;

/** Wrap an angle (radians) to (-pi, pi]. Exported for apps/sim's envelope validation. */
export function wrapAngle(a: number): number {
  return (((a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
}

export function createShadowState(x: number, z: number, h: number): ShadowBoatState {
  return { x, z, h, speed: 0, thr: 0, steer: 0, gear: 'D' };
}

/** Advance the shadow model one fixed step. Pure: returns a new state, never mutates inputs. */
export function stepBoatShadow(state: ShadowBoatState, input: BoatInput, env: ShadowEnv, dt: number): ShadowBoatState {
  const hull = env.hull;
  const topMs = hull.top * 0.5144 * SPEED_SCALE;
  const next: ShadowBoatState = { ...state };

  const tt =
    next.gear === 'D'
      ? input.fwd
        ? 1
        : 0
      : next.gear === 'R'
        ? input.fwd || input.back
          ? -0.35
          : 0
        : 0;
  next.thr += (tt - next.thr) * Math.min(1, dt * 2.5);

  const fr = Math.abs(next.speed) / topMs;
  const opt = fr < 0.35 ? 0.15 : 0.15 + 0.55 * Math.min(1, (fr - 0.35) / 0.5);
  const off = SHADOW_TRIM_V - opt;
  const trimK = 1 + 0.06 - 0.35 * off * off;
  const target = next.thr * topMs * trimK;
  const holeShot = fr < 0.4 && next.thr > 0.5 ? 1 + 0.45 * (0.3 - SHADOW_TRIM_V) : 1;
  next.speed += (target - next.speed) * dt * (next.thr === 0 ? hull.accel * 0.5 : hull.accel * holeShot);

  const st = input.left ? 1 : input.right ? -1 : 0;
  next.steer += (st - next.steer) * Math.min(1, dt * 4);

  const f = Math.abs(next.speed) / topMs;
  next.h =
    wrapAngle(
      next.h +
        hull.turn *
          next.steer *
          (0.3 + Math.min(1, Math.abs(next.speed) / 8) * 0.9) *
          (1 - 0.35 * f) *
          (1.15 - 0.35 * SHADOW_TRIM_V) *
          (next.speed < -0.2 ? -1 : 1) *
          dt,
    );

  const fx = -Math.sin(next.h);
  const fz = -Math.cos(next.h);
  next.x += fx * next.speed * dt;
  next.z += fz * next.speed * dt;

  const amp = ampAt(next.x, next.z);
  const sl = waveSlope(next.x, next.z, env.t, amp, env.sw, env.ch);
  const along = sl[0] * fx + sl[1] * fz;
  next.speed -= along * 9.8 * 0.5 * dt;

  return next;
}
