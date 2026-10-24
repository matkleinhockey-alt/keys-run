/**
 * The tension bar has to agree with the line.
 *
 * The track painted its warning and snapping zones at a fixed 82% and 100% in CSS, while the
 * line actually parts at `limit` — which starts at 1 and falls to 0.45 as the leader chafes
 * (`limit = 1 - 0.55 * abrasion`, sim/fight.ts). So after a long fight the line let go at 45%
 * tension with the meter still showing green to 82%: it promised safety exactly where there was
 * none. These pin the zones to the live limit.
 */
import { describe, expect, it } from 'vitest';
import { HOT_FRACTION, tensionZones } from '../src/sim/fight.js';

/** The worn-leader end of the range: sim/fight.ts's `limit = 1 - 0.55 * abrasion`. */
const limitAt = (abrasion: number): number => 1 - 0.55 * abrasion;

describe('tension bar zones', () => {
  it('matches the old fixed track on a fresh, unchafed leader', () => {
    const z = tensionZones(1);
    expect(z.warnPct).toBeCloseTo(80, 1);
    expect(z.snapPct).toBe(100);
  });

  it('never paints safe water past the point the line parts', () => {
    for (let a = 0; a <= 1.0001; a += 0.05) {
      const limit = limitAt(a);
      const z = tensionZones(limit);
      // The bar's own fill is tension*100, so the snap zone must begin exactly at the tension
      // that breaks the line — not beyond it.
      expect(z.snapPct).toBeCloseTo(limit * 100, 1);
      expect(z.warnPct).toBeLessThan(z.snapPct);
    }
  });

  it('moves the danger zone left as the leader wears', () => {
    const fresh = tensionZones(limitAt(0));
    const half = tensionZones(limitAt(0.5));
    const worn = tensionZones(limitAt(1));
    expect(half.snapPct).toBeLessThan(fresh.snapPct);
    expect(worn.snapPct).toBeLessThan(half.snapPct);
    // The case that used to lie outright: a fully chafed leader parts at 45%, well inside what
    // the old fixed track painted as green.
    expect(worn.snapPct).toBeCloseTo(45, 1);
    expect(worn.warnPct).toBeCloseTo(36, 1);
  });

  it('agrees with the threshold the HUD uses to turn the bar hot', () => {
    for (const limit of [1, 0.8, 0.6, 0.45]) {
      expect(tensionZones(limit).warnPct).toBeCloseTo(limit * HOT_FRACTION * 100, 1);
    }
  });

  it('stays on the bar for a nonsense limit', () => {
    for (const bad of [-1, 0, 1.5, Number.NaN]) {
      const z = tensionZones(bad);
      if (Number.isNaN(bad)) continue;
      expect(z.snapPct).toBeGreaterThanOrEqual(0);
      expect(z.snapPct).toBeLessThanOrEqual(100);
      expect(z.warnPct).toBeGreaterThanOrEqual(0);
      expect(z.warnPct).toBeLessThanOrEqual(100);
    }
  });
});
