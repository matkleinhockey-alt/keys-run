/**
 * The living-ocean model. These pin PROPERTIES (no-op when pristine, monotone, bounded, a
 * believable session), not the coefficients, so the curve can be retuned without rewriting the
 * tests, but not into something that breaks the game.
 */
import { describe, it, expect } from 'vitest';
import {
  recovery, sizeScale, rarityScale, applyOceanSize, decayedPressure, pressureAfterCatch,
  PRESSURE_CAP, SIZE_SCALE_MIN, SIZE_SCALE_MAX, RARITY_SCALE_MIN, RARITY_SCALE_MAX,
} from '../src/sim/ocean.js';
import { SPECIES } from '../src/content/species.js';

const NASTY = [
  0, -0, 1, -1, 0.5, 12, 60, 1e3, 1e9, 1e300, -1e300, Number.MAX_VALUE, -Number.MAX_VALUE,
  Number.MIN_VALUE, Number.EPSILON, Infinity, -Infinity, NaN,
];

describe('pristine water is a no-op', () => {
  it('zero pressure is recovery exactly 1 at any time, and both scales exactly 1', () => {
    for (const h of [...NASTY, 24, 1e6]) expect(recovery(0, h)).toBe(1);
    expect(sizeScale(1)).toBe(1);
    expect(rarityScale(1)).toBe(1);
    expect(sizeScale(recovery(0, 0))).toBe(1);
    expect(rarityScale(recovery(0, 0))).toBe(1);
  });

  it('leaves every species and every weight untouched', () => {
    for (const S of Object.values(SPECIES)) {
      for (let t = 0; t <= 1; t += 0.05) {
        const w = S.min + t * (S.max - S.min);
        expect(applyOceanSize(w, S.min, S.max, recovery(0, 0))).toBe(w);
      }
    }
  });

  it('negative or garbage pressure counts as pristine, not as a bonus', () => {
    for (const p of [-1, -1e9, -Infinity, NaN]) expect(recovery(p, 0)).toBe(1);
  });
});

describe('monotonic', () => {
  const pressures = [0, 1, 2, 5, 12, 30, 60, 100];
  const hours = [0, 1, 6, 24, 48, 96, 1000];

  it('more pressure never gives bigger fish or better odds', () => {
    for (const h of hours) {
      for (let i = 1; i < pressures.length; i++) {
        const a = recovery(pressures[i - 1], h), b = recovery(pressures[i], h);
        expect(b).toBeLessThanOrEqual(a);
        expect(sizeScale(b)).toBeLessThanOrEqual(sizeScale(a));
        expect(rarityScale(b)).toBeLessThanOrEqual(rarityScale(a));
      }
    }
  });

  it('more rest never gives smaller fish or worse odds', () => {
    for (const p of pressures) {
      for (let i = 1; i < hours.length; i++) {
        const a = recovery(p, hours[i - 1]), b = recovery(p, hours[i]);
        expect(b).toBeGreaterThanOrEqual(a);
        expect(sizeScale(b)).toBeGreaterThanOrEqual(sizeScale(a));
        expect(rarityScale(b)).toBeGreaterThanOrEqual(rarityScale(a));
      }
    }
  });

  it('the scales themselves are non-decreasing in recovery', () => {
    let ps = 0, pr = 0;
    for (let i = 0; i <= 100; i++) {
      const r = i / 100;
      expect(sizeScale(r)).toBeGreaterThanOrEqual(ps);
      expect(rarityScale(r)).toBeGreaterThanOrEqual(pr);
      ps = sizeScale(r); pr = rarityScale(r);
    }
  });

  it('applied weight is monotone in pressure for a fixed roll', () => {
    const S = SPECIES.mutton;
    let prev = Infinity;
    for (let p = 0; p <= 80; p += 2) {
      const w = applyOceanSize(15, S.min, S.max, recovery(p, 0));
      expect(w).toBeLessThanOrEqual(prev);
      prev = w;
    }
  });
});

describe('bounded and finite for any input', () => {
  it('recovery stays in 0..1 and finite across the nasty cross-product', () => {
    for (const p of NASTY) for (const h of NASTY) {
      const r = recovery(p, h);
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    }
  });

  it('scales stay inside their stated bounds for any recovery, including nonsense', () => {
    for (const r of NASTY) {
      const s = sizeScale(r), q = rarityScale(r);
      expect(Number.isFinite(s)).toBe(true);
      expect(Number.isFinite(q)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(SIZE_SCALE_MIN);
      expect(s).toBeLessThanOrEqual(SIZE_SCALE_MAX);
      expect(q).toBeGreaterThanOrEqual(RARITY_SCALE_MIN);
      expect(q).toBeLessThanOrEqual(RARITY_SCALE_MAX);
    }
  });

  it('the worst water sits at the stated floors, and never below', () => {
    expect(sizeScale(0)).toBe(SIZE_SCALE_MIN);
    expect(rarityScale(0)).toBeCloseTo(RARITY_SCALE_MIN, 12);
    expect(sizeScale(recovery(Infinity, 0))).toBeGreaterThanOrEqual(SIZE_SCALE_MIN);
    expect(rarityScale(recovery(Infinity, 0))).toBeGreaterThanOrEqual(RARITY_SCALE_MIN);
  });

  it('negative time never recovers or depletes differently from zero time', () => {
    for (const p of [1, 12, 60]) {
      expect(recovery(p, -100)).toBe(recovery(p, 0));
      expect(recovery(p, -Infinity)).toBe(recovery(p, 0));
    }
  });

  it('infinite rest is fully recovered; NaN time is treated as no rest', () => {
    expect(recovery(60, Infinity)).toBe(1);
    expect(recovery(60, NaN)).toBe(recovery(60, 0));
  });

  it('applied weight never leaves the species own min/max, even for absurd weights', () => {
    for (const S of Object.values(SPECIES)) {
      for (const w of [...NASTY, S.min, S.max, S.max * 10]) {
        for (const r of [0, 0.3, 1, NaN, -5, 7]) {
          const out = applyOceanSize(w, S.min, S.max, r);
          expect(Number.isFinite(out)).toBe(true);
          expect(out).toBeGreaterThanOrEqual(S.min);
          expect(out).toBeLessThanOrEqual(S.max);
        }
      }
    }
  });

  it('stored pressure can never exceed the cap however long the grind', () => {
    let p = 0;
    for (let i = 0; i < 10_000; i++) p = pressureAfterCatch(p, 0);
    expect(p).toBe(PRESSURE_CAP);
    expect(pressureAfterCatch(Infinity, 0)).toBeLessThanOrEqual(PRESSURE_CAP);
    expect(Number.isFinite(pressureAfterCatch(NaN, NaN))).toBe(true);
  });

  it('is deterministic', () => {
    expect(recovery(23, 17.5)).toBe(recovery(23, 17.5));
    expect(decayedPressure(23, 17.5)).toBe(decayedPressure(23, 17.5));
  });
});

describe('a realistic session', () => {
  // A mutton snapper (4-22 lb) with a median roll, one catch every two minutes for an hour at the
  // same spot, then the player logs off for a day.
  const S = SPECIES.mutton;
  const roll = (S.min + S.max) / 2;
  const sizeAt = (p: number, h: number) => applyOceanSize(roll, S.min, S.max, recovery(p, h));

  function workOneHour() {
    let p = 0;
    const firstFish = sizeAt(p, 0);
    for (let i = 0; i < 30; i++) p = pressureAfterCatch(p, 2 / 60);
    return { p, firstFish };
  }

  it('shrinks over the hour, and a day away gives back some of the loss', () => {
    const { p, firstFish } = workOneHour();
    const justAfter = sizeAt(p, 0);
    const dayLater = sizeAt(p, 24);
    const weekLater = sizeAt(p, 24 * 7);
    console.log(`ocean scenario (mutton, median roll ${roll} lb): pressure ${p.toFixed(1)}; ` +
      `before ${firstFish.toFixed(2)} lb, after the hour ${justAfter.toFixed(2)} lb ` +
      `(recovery ${recovery(p, 0).toFixed(3)}), a day later ${dayLater.toFixed(2)} lb ` +
      `(recovery ${recovery(p, 24).toFixed(3)}), a week later ${weekLater.toFixed(2)} lb`);

    expect(firstFish).toBe(roll);
    expect(justAfter).toBeLessThan(roll * 0.9);
    expect(justAfter).toBeGreaterThanOrEqual(roll * SIZE_SCALE_MIN - 1e-9);
    expect(dayLater).toBeGreaterThan(justAfter);
    expect(dayLater).toBeLessThan(roll);
    expect(weekLater).toBeGreaterThan(roll * 0.99);
  });

  it('a casual handful of fish is barely noticeable', () => {
    let p = 0;
    for (let i = 0; i < 3; i++) p = pressureAfterCatch(p, 0.1);
    expect(sizeAt(p, 0)).toBeGreaterThan(roll * 0.95);
  });

  it('trophy odds fall faster than average size does', () => {
    const { p } = workOneHour();
    const r = recovery(p, 0);
    expect(rarityScale(r)).toBeLessThan(sizeScale(r));
  });
});
