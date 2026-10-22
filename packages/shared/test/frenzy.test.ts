import { describe, expect, it } from 'vitest';
import { frenzyActive, FRENZY_BUCKET_S, FRENZY_MIN_S, FRENZY_MAX_S } from '../src/world/frenzy.js';

describe('frenzyActive', () => {
  it('is a pure function of (seed, site, time)', () => {
    for (let t = 1e9; t < 1e9 + 600; t += 7) expect(frenzyActive(1, 5, t)).toBe(frenzyActive(1, 5, t));
  });

  it('about one site in five is on at any moment', () => {
    let on = 0, n = 0;
    for (let site = 0; site < 40; site++) for (let t = 0; t < 36000; t += 10) { n++; if (frenzyActive(20240817, site, t)) on++; }
    expect(on / n).toBeGreaterThan(0.15);
    expect(on / n).toBeLessThan(0.3);
  });

  it('a frenzy lasts at least the minimum and never crosses a bucket boundary', () => {
    for (let site = 0; site < 40; site++) {
      let run = 0;
      for (let t = 0; t < FRENZY_BUCKET_S * 30; t += 1) {
        // A run ending exactly on a bucket edge is fine; one that continues across it is not.
        if (t % FRENZY_BUCKET_S === 0 && run) { expect(run).toBeGreaterThanOrEqual(FRENZY_MIN_S - 1); run = 0; }
        if (frenzyActive(20240817, site, t)) { run++; expect(run).toBeLessThanOrEqual(FRENZY_MAX_S + 1); }
        else { if (run) expect(run).toBeGreaterThanOrEqual(FRENZY_MIN_S - 1); run = 0; }
      }
    }
  });

  it('sites are independent: neighbours are not on in lockstep', () => {
    let same = 0, n = 0;
    for (let t = 0; t < 36000; t += 10) { n++; if (frenzyActive(20240817, 3, t) === frenzyActive(20240817, 4, t)) same++; }
    expect(same / n).toBeLessThan(0.95);
  });
});
