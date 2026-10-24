import { describe, expect, it } from 'vitest';
import { SPECIES } from '../src/content/species.js';
import { growthCeiling, grownWeight, tagCode, tagNoFromCode, wanderRadiusM } from '../src/sim/tagging.js';

/** Ten years at large: fully converged on whatever this fish's ceiling is. */
const FOREVER = 3650;

describe('tagged fish growth', () => {
  it('grows monotonically towards this fish\'s own ceiling, and never past it', () => {
    const tagNo = 42;
    const ceiling = +growthCeiling('mahi', 20, tagNo).toFixed(2);
    let prev = 20;
    for (const days of [1, 7, 30, 90, 365, 5000]) {
      const w = grownWeight('mahi', 20, days, tagNo);
      expect(w).toBeGreaterThan(prev);
      expect(w).toBeLessThanOrEqual(ceiling);
      expect(w).toBeLessThanOrEqual(SPECIES.mahi.max);
      prev = w;
    }
  });

  it('is visible between recaptures without being a record within a week', () => {
    // A fish with room to grow: picked by ceiling rather than hardcoding a tag number, so this
    // stays meaningful if the hash changes.
    const roomy = [...Array(200).keys()].map((i) => i + 1).find((n) => growthCeiling('mahi', 20, n) > 45)!;
    expect(grownWeight('mahi', 20, 14, roomy)).toBeGreaterThan(24);
    expect(grownWeight('mahi', 20, 7, roomy)).toBeLessThan(30);
  });

  it('leaves a fish alone with no time elapsed, and never shrinks one tagged over the max', () => {
    expect(grownWeight('mahi', 20, 0, 1)).toBe(20);
    expect(grownWeight('mahi', 20, -5, 1)).toBe(20);
    expect(grownWeight('mahi', 60, 100, 1)).toBe(60);
    expect(grownWeight('not-a-fish', 5, 100, 1)).toBe(5);
  });

  // The whole point of the per-fish ceiling. Growing every tag towards SPECIES.max meant a
  // tarpon tagged at 80 lb hit 159.95 of a 160 lb maximum inside a year — and so did every other
  // tarpon, so the species leaderboard became a question of patience rather than of fishing.
  it('does not let time alone manufacture a record', () => {
    const maxed = [];
    for (let tagNo = 1; tagNo <= 400; tagNo++) {
      const w = grownWeight('tarpon', 80, FOREVER, tagNo);
      expect(w).toBeLessThanOrEqual(SPECIES.tarpon.max);
      if (w >= SPECIES.tarpon.max * 0.98) maxed.push(tagNo);
    }
    expect(maxed.length).toBeLessThan(40); // was all 400 under the old asymptote
  });

  it('spreads individual ceilings across the upper half of the range', () => {
    const S = SPECIES.tarpon;
    const mid = (S.min + S.max) / 2;
    const ceilings = [...Array(400).keys()].map((i) => growthCeiling('tarpon', 10, i + 1));
    expect(Math.min(...ceilings)).toBeGreaterThanOrEqual(mid - 1e-9);
    expect(Math.max(...ceilings)).toBeLessThanOrEqual(S.max);
    const belowThreeQuarters = ceilings.filter((c) => c < mid + (S.max - mid) * 0.5).length;
    expect(belowThreeQuarters).toBeGreaterThan(120);
    expect(belowThreeQuarters).toBeLessThan(280);
  });

  // Nothing is stored, so the API registry and the client's offline one must derive the same
  // ceiling for the same tag or a fish would change size depending on who asked.
  it('gives the same fish the same ceiling every time it is evaluated', () => {
    for (const tagNo of [1, 42, 999, 123456]) {
      expect(growthCeiling('mahi', 12, tagNo)).toBe(growthCeiling('mahi', 12, tagNo));
      expect(grownWeight('mahi', 12, 200, tagNo)).toBe(grownWeight('mahi', 12, 200, tagNo));
    }
  });

  it('wanders further the longer it is at large, up to a cap', () => {
    expect(wanderRadiusM(0)).toBeLessThan(wanderRadiusM(10));
    expect(wanderRadiusM(Infinity)).toBe(1500);
  });

  it('formats tag numbers, and reads them back out of a printed code', () => {
    expect(tagCode(42)).toBe('KR-00042');
    expect(tagNoFromCode('KR-00042')).toBe(42);
    expect(tagNoFromCode(tagCode(12345))).toBe(12345);
    expect(tagNoFromCode('nonsense')).toBe(0);
  });
});
