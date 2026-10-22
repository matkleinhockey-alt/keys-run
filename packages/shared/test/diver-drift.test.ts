/**
 * Hands off the controls, a diver comes UP. Slowly, from any depth.
 *
 * This reverses the original model, which was honest freediving physics: buoyancy went negative
 * below `NEUTRAL_DEPTH` and capped at a 2 m/s² freefall. In play that reads as the game taking
 * the diver away from you — let go to look at something and you are quietly on your way to the
 * bottom, and the pull is hardest exactly when you are deepest, have least air, and most need to
 * be careful. It is also wrong for a diver wearing the dive shop's gear: someone trimmed out
 * comes up slowly when they stop working.
 *
 * "Slowly" is the load-bearing word, and it is why this file exists rather than a single
 * sign-flip assertion: a diver hanging over a reef must stay there long enough to look at it.
 */
import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_DEPTH, BUOY_DRIFT_UP_ACCEL, buoyancyAccel,
  createDiverState, stepDiver,
  type DiverEnv, type DiverInput, type DiverState, type SeafloorSampler,
} from '../src/sim/diver.js';

const DT = 1 / 30;
const DEEP_FLOOR: SeafloorSampler = { heightAt: () => -120 };
const OPEN_BOUNDS = { x0: -1e6, x1: 1e6, z0: -1e6, z1: 1e6 };
const env = (t: number): DiverEnv => ({ t, seafloor: DEEP_FLOOR, worldBounds: OPEN_BOUNDS });
const NO_INPUT: DiverInput = {
  fwd: false, back: false, left: false, right: false, ascend: false, descend: false, sprint: false,
  lookYaw: 0, lookPitch: 0,
};
/** Inshore Florida Bay at slack tide — the current is near zero, so this measures buoyancy. */
const CALM = { x: -3000, z: -2500 };

/** Depth (m, positive) after `secs` of doing nothing at all, from `startDepth`. */
function driftTo(startDepth: number, secs: number): number {
  let s: DiverState = createDiverState(CALM.x, -startDepth, CALM.z, 0);
  for (let i = 0; i < Math.round(secs / DT); i++) s = stepDiver(s, NO_INPUT, env(i * DT), DT);
  return -s.y;
}

describe('buoyancy never pulls the diver down', () => {
  it('is positive at every depth, including far below neutral', () => {
    for (const d of [0, 5, NEUTRAL_DEPTH, 15, 30, 45, 80, 200]) {
      expect(buoyancyAccel(d), `${d} m`).toBeGreaterThanOrEqual(BUOY_DRIFT_UP_ACCEL);
    }
  });

  it('still pushes hardest at the surface, so a duck-dive is work', () => {
    expect(buoyancyAccel(0)).toBeGreaterThan(buoyancyAccel(5));
    expect(buoyancyAccel(5)).toBeGreaterThan(buoyancyAccel(NEUTRAL_DEPTH));
  });
});

describe('a diver who lets go of the controls', () => {
  it.each([15, 25, 40])('rises rather than sinking, from %i m', (start) => {
    expect(driftTo(start, 20)).toBeLessThan(start);
  });

  it('rises SLOWLY — you can hang over a reef and look at it', () => {
    // The whole point of the small floor on buoyancy. A diver at 25 m who stops swimming must
    // still be at a sensible working depth half a minute later, not on the way to the surface.
    const after30s = driftTo(25, 30);
    expect(after30s).toBeLessThan(25);        // it is going up
    expect(after30s).toBeGreaterThan(20);     // ...but has not run away with them
  });

  it('does not stall at neutral depth the way the old curve did', () => {
    // The old model crossed exactly zero at NEUTRAL_DEPTH, so a diver left there hung forever.
    expect(driftTo(NEUTRAL_DEPTH, 25)).toBeLessThan(NEUTRAL_DEPTH - 0.5);
  });

  it('arrives at the surface rather than launching out of it', () => {
    let s: DiverState = createDiverState(CALM.x, -8, CALM.z, 0);
    let top = -Infinity;
    for (let i = 0; i < 30 * 90; i++) { s = stepDiver(s, NO_INPUT, env(i * DT), DT); top = Math.max(top, s.y); }
    expect(top).toBeLessThan(0.5);
  });
});
