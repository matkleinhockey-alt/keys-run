import { describe, expect, it } from 'vitest';
import { SPECIES } from '../src/content/species.js';
import { grownWeight, tagCode, wanderRadiusM } from '../src/sim/tagging.js';

describe('tagged fish growth', () => {
  it('grows toward the species max, monotonically, and never past it', () => {
    let prev = 20;
    for (const days of [1, 7, 30, 90, 365, 5000]) {
      const w = grownWeight('mahi', 20, days);
      expect(w).toBeGreaterThan(prev);
      expect(w).toBeLessThanOrEqual(SPECIES.mahi.max);
      prev = w;
    }
    // Visible between recaptures, not a record within a week.
    expect(grownWeight('mahi', 20, 14)).toBeGreaterThan(24);
    expect(grownWeight('mahi', 20, 7)).toBeLessThan(30);
  });

  it('leaves a fish alone with no time elapsed, and never shrinks one tagged over the max', () => {
    expect(grownWeight('mahi', 20, 0)).toBe(20);
    expect(grownWeight('mahi', 60, 100)).toBe(60);
    expect(grownWeight('not-a-fish', 5, 100)).toBe(5);
  });

  it('wanders further the longer it is at large, up to a cap', () => {
    expect(wanderRadiusM(0)).toBeLessThan(wanderRadiusM(10));
    expect(wanderRadiusM(Infinity)).toBe(1500);
  });

  it('formats tag numbers', () => {
    expect(tagCode(42)).toBe('KR-00042');
  });
});
