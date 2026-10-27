/**
 * The tension bar reads load against what the line will take.
 *
 * The gauge has been wrong twice, in two different ways, and these pin both of them shut.
 *
 * 1. It showed raw tension on a fixed 0..1 scale while the line actually parts at `limit`, which
 *    falls to 0.45 as the leader chafes — so late in a fight it showed green where the line was
 *    already gone.
 * 2. Worse, on an ordinary fish the needle never moved out of the bottom half: measured over
 *    full fights a blackfin peaks at 0.72 tension at the tightest drag, against a red zone
 *    starting near 0.76. "Back off when the bar runs red" was unachievable for most of the game.
 */
import { describe, expect, it } from 'vitest';
import {
  HOT_FRACTION, TENSION_WARN_PCT, TENSION_SNAP_PCT, tensionFrac,
  startFight, stepFight, fightParamsFor,
} from '../src/sim/fight.js';

describe('the tension gauge', () => {
  it('reads full exactly when the line is at its limit, worn or fresh', () => {
    for (const limit of [1, 0.8, 0.6, 0.45]) {
      expect(tensionFrac(limit, limit), `limit ${limit}`).toBeCloseTo(1, 10);
    }
  });

  it('shows a worn leader as closer to going, for the same pull', () => {
    const fresh = tensionFrac(0.5, 1);
    const worn = tensionFrac(0.5, 0.5);
    expect(worn).toBeGreaterThan(fresh);
    expect(worn).toBeCloseTo(1, 10);   // the same 0.5 that was half a bar is now all of it
  });

  it('keeps the marks still, because the scale moves instead', () => {
    expect(TENSION_WARN_PCT).toBeCloseTo(HOT_FRACTION * 100, 6);
    expect(TENSION_SNAP_PCT).toBe(100);
  });

  it('never divides by a collapsed limit', () => {
    for (const bad of [0, -1, Number.EPSILON]) {
      const f = tensionFrac(0.5, bad);
      expect(Number.isFinite(f), `limit ${bad}`).toBe(true);
      expect(f).toBeGreaterThan(0);
    }
  });

  it('actually reaches the red zone on an ordinary fish, which is the whole point', () => {
    // The failure this replaced: a blackfin at maximum drag could not make the bar run red at
    // all, so the HUD's own instruction was unfollowable. Fight one and watch the gauge.
    const peak = (key: string, weight: number, drag: number): number => {
      let seed = 11;
      const rng = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
      const p = fightParamsFor(key, weight, drag);
      let f = startFight(p, -900, 2620, rng);
      let top = 0;
      for (let i = 0; i < 3600 && f.outcome === 'fighting'; i++) {
        f = stepFight(f, { reeling: true, drag }, p, { boatX: -900, boatZ: 2600 }, rng, 1 / 30);
        top = Math.max(top, tensionFrac(f.tension, f.limit));
      }
      return top;
    };
    expect(peak('blackfin', 30, 5), 'hard drag on a blackfin should load the bar up').toBeGreaterThan(HOT_FRACTION);
    // ...and a light drag on the same fish should NOT, or the gauge is just pegged all the time
    // and tells you nothing either.
    expect(peak('blackfin', 30, 1)).toBeLessThan(HOT_FRACTION);
  });
});
