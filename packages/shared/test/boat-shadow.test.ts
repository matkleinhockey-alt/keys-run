import { describe, expect, it } from 'vitest';
import { createShadowState, stepBoatShadow, type ShadowEnv } from '../src/sim/boat-shadow.js';
import type { BoatHull, BoatInput } from '../src/sim/boat.js';
import { BOATS } from '../src/content/boats.js';

const DT = 1 / 30;
const NEUTRAL: BoatInput = { fwd: false, back: false, left: false, right: false, trimUp: false, trimDn: false };
const FULL_FWD: BoatInput = { ...NEUTRAL, fwd: true };
const FULL_FWD_LEFT: BoatInput = { ...FULL_FWD, left: true };

/**
 * `stepBoat`/`stepBoatShadow`'s `BoatHull` ({len,beam,top,accel,turn,draft,cat}) lives on the
 * top-level `BOATS` entries, NOT on `content/boats.ts`'s `HULLS` map (that's `HullSpec` —
 * cosmetic/rendering trim-curve data: colors, style, F/spring/yk/rake/entry/steps — it has no
 * `top`/`accel`/`turn`/`draft` at all).
 */
function hullOf(id: string): BoatHull {
  const b = BOATS.find((x) => x.id === id);
  if (!b) throw new Error(`unknown boat id ${id}`);
  return { len: b.len, beam: b.beam, top: b.top, accel: b.accel, turn: b.turn, draft: b.draft, cat: b.cat };
}

const ROBALO_HULL = hullOf('robalo');

function envAt(t: number): ShadowEnv {
  return { t, hull: ROBALO_HULL, sw: 0.9, ch: 1 };
}

describe('stepBoatShadow', () => {
  it('is pure: never mutates the state/input/env passed in', () => {
    const state = createShadowState(0, 0, 0);
    const frozenState = { ...state };
    const frozenInput = { ...FULL_FWD };
    stepBoatShadow(state, FULL_FWD, envAt(0), DT);
    expect(state).toEqual(frozenState);
    expect(FULL_FWD).toEqual(frozenInput);
  });

  it('accelerates from rest under full throttle and stays within the hull speed envelope', () => {
    let state = createShadowState(0, 0, 0);
    const hull = ROBALO_HULL;
    const topMs = hull.top * 0.5144 * 1.35;
    for (let i = 0; i < 30 * 20; i++) {
      state = stepBoatShadow(state, FULL_FWD, envAt(i * DT), DT);
      expect(Math.abs(state.speed)).toBeLessThanOrEqual(topMs * 1.15);
    }
    expect(state.speed).toBeGreaterThan(topMs * 0.8);
  });

  it('turns left under left-rudder + throttle (heading decreases monotonically while turning)', () => {
    let state = createShadowState(0, 0, 0);
    let prevH = state.h;
    let turned = false;
    for (let i = 0; i < 90; i++) {
      state = stepBoatShadow(state, FULL_FWD_LEFT, envAt(i * DT), DT);
      if (i > 10) {
        expect(state.h).not.toBe(prevH);
        turned = true;
      }
      prevH = state.h;
    }
    expect(turned).toBe(true);
  });

  it('every hull in BOATS steps without NaN/Infinity over a 10s run', () => {
    for (const boat of BOATS) {
      let state = createShadowState(0, 0, 0);
      const hull = hullOf(boat.id);
      for (let i = 0; i < 30 * 10; i++) {
        state = stepBoatShadow(state, FULL_FWD, { t: i * DT, hull, sw: 1.2, ch: 1.5 }, DT);
      }
      expect(Number.isFinite(state.x)).toBe(true);
      expect(Number.isFinite(state.z)).toBe(true);
      expect(Number.isFinite(state.h)).toBe(true);
      expect(Number.isFinite(state.speed)).toBe(true);
    }
  });

  it('idle (neutral input) decelerates toward zero speed from a moving start', () => {
    let state = { ...createShadowState(0, 0, 0), speed: 20, thr: 1 };
    for (let i = 0; i < 30 * 10; i++) {
      state = stepBoatShadow(state, NEUTRAL, envAt(i * DT), DT);
    }
    expect(Math.abs(state.speed)).toBeLessThan(2);
  });
});
