/**
 * Freedive physics tests for sim/diver.ts (docs/ARCHITECTURE.md "Freedive physics"). Covers the
 * four things the task brief calls out explicitly — the ATA air-drain model at depth, the
 * buoyancy sign flip around neutral depth, blackout firing at zero air, and determinism — plus a
 * few more (shallow-water blackout, narcosis threshold, surface refill, seafloor collision) that
 * exercise the rest of the module the same way.
 */

import { describe, expect, it } from 'vitest';
import {
  AIR_MAX, NEUTRAL_DEPTH, BUOY_SURFACE_ACCEL, BUOY_MAX_NEGATIVE_ACCEL, NARCOSIS_DEPTH,
  SHALLOW_BLACKOUT_DEPTH, SURFACE_EPS, DIVER_RADIUS,
  ataAt, buoyancyAccel, airBurnRate, currentAt,
  createDiverState, stepDiver,
  type DiverEnv, type DiverInput, type DiverState, type SeafloorSampler,
} from '../src/sim/diver.js';

const DT = 1 / 30;

const DEEP_FLOOR: SeafloorSampler = { heightAt: () => -1000 };
const OPEN_BOUNDS = { x0: -1e6, x1: 1e6, z0: -1e6, z1: 1e6 };

function baseEnv(t = 0, seafloor: SeafloorSampler = DEEP_FLOOR): DiverEnv {
  return { t, seafloor, worldBounds: OPEN_BOUNDS };
}

const NO_INPUT: DiverInput = {
  fwd: false, back: false, left: false, right: false, ascend: false, descend: false, sprint: false,
  lookYaw: 0, lookPitch: 0,
};

describe('ataAt / airBurnRate: the ATA air-drain model', () => {
  it('ATA = 1 + depth/10, matching the doc exactly at 0/10/20/30 m', () => {
    expect(ataAt(0)).toBe(1);
    expect(ataAt(10)).toBe(2);
    expect(ataAt(20)).toBe(3);
    expect(ataAt(30)).toBe(4);
  });

  it('at rest (exertion=0), air burn rate equals ATA — so AIR_MAX seconds of budget lasts exactly AIR_MAX seconds at the surface', () => {
    expect(airBurnRate(0, 0)).toBe(1);
    expect(airBurnRate(10, 0)).toBe(2);
    expect(airBurnRate(20, 0)).toBe(3);
    expect(airBurnRate(30, 0)).toBe(4);
  });

  it('20 m burns air 3x faster than the surface, per the doc', () => {
    expect(airBurnRate(20, 0) / airBurnRate(0, 0)).toBe(3);
  });

  it('exertion multiplies the burn rate on top of ATA', () => {
    const rest = airBurnRate(20, 0);
    const sprinting = airBurnRate(20, 1);
    expect(sprinting).toBeGreaterThan(rest);
  });

  it('stepDiver drains air by exactly airBurnRate(depth, exertion)*dt for a stationary, non-kicking diver mid-water', () => {
    const state = createDiverState(0, -20, 0, 0);
    const next = stepDiver(state, NO_INPUT, baseEnv(0), DT);
    // No kick input -> exertion target is 0 -> exertion stays 0 (it started at 0), so the burn
    // this step is airBurnRate(20, 0)*dt exactly (same floating-point expression on both sides).
    expect(next.air).toBe(AIR_MAX - airBurnRate(20, 0) * DT);
  });
});

describe('buoyancyAccel: the depth-dependent sign flip', () => {
  it('is positive 0-10 m (you must kick down)', () => {
    expect(buoyancyAccel(0)).toBeGreaterThan(0);
    expect(buoyancyAccel(5)).toBeGreaterThan(0);
    expect(buoyancyAccel(10)).toBeGreaterThan(0);
  });

  it('is exactly zero at NEUTRAL_DEPTH (within the doc\'s ~10-12 m neutral band)', () => {
    expect(NEUTRAL_DEPTH).toBeGreaterThanOrEqual(10);
    expect(NEUTRAL_DEPTH).toBeLessThanOrEqual(12);
    expect(buoyancyAccel(NEUTRAL_DEPTH)).toBe(0);
  });

  it('is negative below neutral depth (freefall)', () => {
    expect(buoyancyAccel(NEUTRAL_DEPTH + 1)).toBeLessThan(0);
    expect(buoyancyAccel(20)).toBeLessThan(0);
  });

  it('caps at BUOY_SURFACE_ACCEL / -BUOY_MAX_NEGATIVE_ACCEL rather than growing without bound', () => {
    expect(buoyancyAccel(0)).toBe(BUOY_SURFACE_ACCEL);
    expect(buoyancyAccel(100)).toBe(-BUOY_MAX_NEGATIVE_ACCEL);
  });
});

describe('blackout', () => {
  it('fires the instant air reaches zero', () => {
    const state: DiverState = { ...createDiverState(0, -15, 0, 0), air: 0.001 };
    const next = stepDiver(state, NO_INPUT, baseEnv(0), DT);
    expect(next.air).toBe(0);
    expect(next.blackedOut).toBe(true);
    expect(next.events).toContainEqual({ type: 'blackout', cause: 'airOut' });
  });

  it('once blacked out, ignores further swim input (unconscious, drifting only)', () => {
    const blacked: DiverState = { ...createDiverState(0, -15, 0, 0), air: 0, blackedOut: true, blackoutT: 0.4 };
    const sprintInput: DiverInput = { ...NO_INPUT, fwd: true, sprint: true };
    const next = stepDiver(blacked, sprintInput, baseEnv(0), DT);
    expect(next.blackedOut).toBe(true);
    expect(next.blackoutT).toBeCloseTo(0.4 + DT, 10);
    // No fin-kick applied: vx/vz only reflect buoyancy/current/drag, never the sprint input.
    expect(next.vx).not.toBe(0); // the current still nudges it...
    const current = currentAt(0, 0, 15, 0);
    expect(next.vx).toBeCloseTo(current.x * DT * (1 - 1.6 * DT), 6);
  });

  it('shallow-water blackout can fire in the final 5 m of ascent on fumes, even with air > 0', () => {
    const state: DiverState = { ...createDiverState(0, -3, 0, 0), vy: 1.0, air: AIR_MAX * 0.05 };
    expect(state.air).toBeGreaterThan(0);
    const next = stepDiver(state, NO_INPUT, baseEnv(0), DT);
    expect(next.blackedOut).toBe(true);
    expect(next.events).toContainEqual({ type: 'blackout', cause: 'shallowWaterBlackout' });
    expect(Math.max(0, -state.y)).toBeLessThan(SHALLOW_BLACKOUT_DEPTH);
  });

  it('does NOT shallow-water-blackout while resting (not ascending) on low air in the shallow band', () => {
    const state: DiverState = { ...createDiverState(0, -3, 0, 0), vy: 0, air: AIR_MAX * 0.05 };
    const next = stepDiver(state, NO_INPUT, baseEnv(0), DT);
    expect(next.blackedOut).toBe(false);
  });

  it('does NOT shallow-water-blackout with plenty of air, even ascending fast in the shallow band', () => {
    const state: DiverState = { ...createDiverState(0, -3, 0, 0), vy: 1.0, air: AIR_MAX * 0.5 };
    const next = stepDiver(state, NO_INPUT, baseEnv(0), DT);
    expect(next.blackedOut).toBe(false);
  });
});

describe('narcosis', () => {
  it('is false just above NARCOSIS_DEPTH and true at/below it', () => {
    const above = stepDiver(createDiverState(0, -(NARCOSIS_DEPTH - 1), 0, 0), NO_INPUT, baseEnv(0), DT);
    const at = stepDiver(createDiverState(0, -NARCOSIS_DEPTH, 0, 0), NO_INPUT, baseEnv(0), DT);
    expect(above.narcosis).toBe(false);
    expect(at.narcosis).toBe(true);
  });
});

describe('surface refill', () => {
  it('air refills while at the surface and not diving back down, capped at AIR_MAX', () => {
    const state: DiverState = { ...createDiverState(0, 0, 0, 0), air: AIR_MAX - 1, vy: 0 };
    const next = stepDiver(state, NO_INPUT, baseEnv(0), DT);
    expect(next.air).toBeGreaterThan(state.air);
    expect(next.air).toBeLessThanOrEqual(AIR_MAX);
  });

  it('does not refill while submerged, even briefly near SURFACE_EPS, if actively descending', () => {
    const state: DiverState = { ...createDiverState(0, -(SURFACE_EPS * 0.5), 0, 0), air: AIR_MAX - 10, vy: -5 };
    const next = stepDiver(state, NO_INPUT, baseEnv(0), DT);
    expect(next.air).toBeLessThan(state.air);
  });
});

describe('seafloor collision', () => {
  it('clamps the diver at seafloor + DIVER_RADIUS and raises groundHit', () => {
    const shallowFloor: SeafloorSampler = { heightAt: () => -5 };
    const state: DiverState = { ...createDiverState(0, -4.9, 0, 0), vy: -3 };
    const next = stepDiver(state, NO_INPUT, baseEnv(0, shallowFloor), DT);
    expect(next.y).toBeCloseTo(-5 + DIVER_RADIUS, 10);
    expect(next.vy).toBe(0);
    expect(next.events).toContainEqual({ type: 'groundHit' });
  });
});

describe('determinism', () => {
  it('a single step from identical state/input/env/dt produces identical output', () => {
    const state = createDiverState(10, -8, -20, 0.3);
    const input: DiverInput = { ...NO_INPUT, fwd: true, lookYaw: 0.3, lookPitch: 0.1 };
    const env = baseEnv(12.5);
    const a = stepDiver(state, input, env, DT);
    const b = stepDiver(state, input, env, DT);
    expect(a).toEqual(b);
  });

  it('a 150-step scripted trajectory is bit-identical when replayed from scratch', () => {
    function runScript(): DiverState {
      let state = createDiverState(0, -1, 0, 0);
      let t = 0;
      for (let i = 0; i < 150; i++) {
        const input: DiverInput = {
          fwd: i % 4 !== 0,
          back: false,
          left: i % 17 === 0,
          right: i % 23 === 0,
          ascend: i % 10 < 3,
          descend: i % 29 === 0,
          sprint: i % 40 < 5,
          lookYaw: Math.sin(i * 0.05) * 0.5,
          lookPitch: Math.cos(i * 0.03) * 0.2,
        };
        state = stepDiver(state, input, baseEnv(t, DEEP_FLOOR), DT);
        t += DT;
      }
      return state;
    }
    const first = runScript();
    const second = runScript();
    expect(second).toEqual(first);
  });
});
