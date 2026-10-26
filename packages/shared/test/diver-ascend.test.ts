/**
 * Coming up for air has to be affordable.
 *
 * Air burns at `ataAt(depth)` times a kicking-exertion multiplier, so the trip up costs air at
 * 3-4x real time from any real depth. That makes ASCEND_SPEED (sim/diver.ts) an air-budget
 * number, not a feel number: too slow and a diver who starts up with air in hand still blacks
 * out short of the surface, holding the ascend key the whole way, with nothing on screen
 * explaining why. That is exactly what shipped at ASCEND_SPEED 2.5 — from 25 m with 45% of a
 * 90 s budget left you drowned 5 m under.
 *
 * These pin the PROPERTY ("the way back is buyable, and deep water still costs you"), not the
 * constant, so the speed can be retuned for feel without silently reinstating the trap.
 */
import { describe, expect, it } from 'vitest';
import {
  AIR_MAX, createDiverState, stepDiver,
  type DiverEnv, type DiverInput, type SeafloorSampler,
} from '../src/sim/diver.js';

const DT = 1 / 60;
const DEEP_FLOOR: SeafloorSampler = { heightAt: () => -1000 };
const env = (): DiverEnv => ({ t: 0, seafloor: DEEP_FLOOR, worldBounds: { x0: -1e6, x1: 1e6, z0: -1e6, z1: 1e6 } });
const NO_INPUT: DiverInput = {
  fwd: false, back: false, left: false, right: false, ascend: false, descend: false, sprint: false,
  lookYaw: 0, lookPitch: 0,
};

/** Holds the ascend key from `depth` starting on `airFrac` of the budget. Calm water, no current. */
function ascend(depth: number, airFrac: number, sprint = false): { surfaced: boolean; secs: number; airLeft: number } {
  let s = createDiverState(-3000, -depth, -2500, 0);
  s.air = AIR_MAX * airFrac;
  for (let i = 0; i < 90 / DT; i++) {
    s = stepDiver(s, { ...NO_INPUT, ascend: true, sprint }, env(), DT);
    if (s.blackedOut) return { surfaced: false, secs: i * DT, airLeft: 0 };
    if (-s.y <= 0.3) return { surfaced: true, secs: i * DT, airLeft: s.air };
  }
  return { surfaced: false, secs: 90, airLeft: s.air };
}

describe('coming up for air', () => {
  // The exact case that used to drown you.
  it('surfaces from 25 m with 45% air, holding ascend the whole way', () => {
    const r = ascend(25, 0.45);
    expect(r.surfaced).toBe(true);
    expect(r.secs).toBeLessThan(12);
  });

  it('leaves a usable margin at the depths the game actually fishes', () => {
    // Half a breath has to be enough to get home from anywhere on the reef.
    for (const depth of [10, 15, 20, 25, 30]) {
      expect(ascend(depth, 0.5).surfaced, `${depth} m on half air`).toBe(true);
    }
    // And the deepest water is reachable, just expensive.
    expect(ascend(40, 0.7).surfaced, '40 m on 70% air').toBe(true);
  });

  it('refills the breath once you get there', () => {
    let s = createDiverState(-3000, -20, -2500, 0);
    s.air = AIR_MAX * 0.5;
    let low = s.air;
    for (let i = 0; i < 30 / DT; i++) {
      s = stepDiver(s, { ...NO_INPUT, ascend: true }, env(), DT);
      low = Math.min(low, s.air);
    }
    expect(s.air).toBeGreaterThan(AIR_MAX * 0.95);
    expect(low).toBeLessThan(AIR_MAX * 0.5); // it really did run down before coming back
  });

  // The reported bug: "I sink faster than I can come up". Descend is bound to Ctrl, a modifier
  // whose keyup the browser eats on Ctrl+R / Ctrl+Tab / Ctrl+click, so it can be stuck down with
  // nothing on screen saying so. The surfacing assist used to be gated on `!input.descend`, so
  // in that state the ascend key did nothing whatever while the descend kick kept firing: from
  // 12 m you ended up at 25.5 m, still going down.
  it('comes up even with descend stuck down, because going up must never be refusable', () => {
    let s = createDiverState(-3000, -12, -2500, 0);
    const startDepth = 12;
    for (let i = 0; i < 20 / DT; i++) {
      s = stepDiver(s, { ...NO_INPUT, ascend: true, descend: true }, env(), DT);
      if (s.blackedOut) break;
    }
    expect(-s.y, 'still sinking with the surface key held').toBeLessThan(startDepth);
    expect(-s.y).toBeLessThan(1);
  });

  it('still lets you go down when only descend is held', () => {
    let s = createDiverState(-3000, -4, -2500, 0);
    for (let i = 0; i < 6 / DT; i++) s = stepDiver(s, { ...NO_INPUT, descend: true }, env(), DT);
    expect(-s.y, 'descend no longer descends').toBeGreaterThan(4);
  });

  it('still punishes leaving it far too late — this is not a free pass', () => {
    expect(ascend(30, 0.1).surfaced, '30 m on a tenth of a breath').toBe(false);
    expect(ascend(40, 0.2).surfaced, '40 m on a fifth').toBe(false);
  });

  it('costs more air the deeper you start, monotonically', () => {
    const left = [10, 20, 30].map((d) => ascend(d, 0.8).airLeft);
    expect(left[0]).toBeGreaterThan(left[1]);
    expect(left[1]).toBeGreaterThan(left[2]);
  });

  // Sprinting raises exertion (and so burn) slightly faster than it saves time, so panic-finning
  // for the surface is marginally worse than a steady ascent. Kept as a documented property: if
  // a future tune makes sprint strictly better, that is a balance change worth noticing.
  it('sprinting to the surface is not a cheaper way up', () => {
    const steady = ascend(30, 0.8);
    const sprinted = ascend(30, 0.8, true);
    expect(sprinted.secs).toBeLessThan(steady.secs);
    expect(sprinted.airLeft).toBeLessThanOrEqual(steady.airLeft + 0.5);
  });
});
