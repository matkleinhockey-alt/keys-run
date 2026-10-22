/**
 * Cast-landing lookup: which table a cast rolls from, and whether it gets the frenzy bonus.
 * The species-mix assertions use the real shared `chooseFish` + `ZONE_TABLE`, because the point
 * of wiring `F.zone` is that species available nowhere else become reachable.
 */
import { describe, expect, it } from 'vitest';
import { xoshiro128ss } from '@keysrun/shared/rng';
import { chooseFish } from '@keysrun/shared/sim/fight';
import { ZONE_TABLE } from '@keysrun/shared/content/species';
import { resolveCastSpot, NO_SPOTS, type SpotQuery } from '../src/game/fishing/spot.js';

const q = (o: Partial<SpotQuery>): SpotQuery => ({ ...NO_SPOTS, ...o });

describe('resolveCastSpot', () => {
  it('leaves plain water alone', () => {
    expect(resolveCastSpot(NO_SPOTS, 0, 0, 'Reef')).toEqual({ zone: 'Reef', hs: null, kind: null });
  });

  it('a live frenzy keeps the zone but sets hs', () => {
    const r = resolveCastSpot(q({ nearHotspot: () => ({ fr: 0.8 }) }), 0, 0, 'Reef');
    expect(r).toEqual({ zone: 'Reef', hs: { fr: 0.8 }, kind: 'frenzy' });
  });

  it('a weedline or rig overrides the zone, and still counts as a hotspot', () => {
    expect(resolveCastSpot(q({ nearWeed: () => ({}) }), 0, 0, 'Offshore')).toMatchObject({ zone: 'Weedline', kind: 'weedline' });
    expect(resolveCastSpot(q({ nearWeed: () => ({}) }), 0, 0, 'Offshore').hs).not.toBeNull();
    expect(resolveCastSpot(q({ nearRig: () => ({}) }), 0, 0, 'Offshore')).toMatchObject({ zone: 'Oil Rig', kind: 'rig' });
  });

  it('a rig wins over a weedline, and keeps a frenzy strength when one overlaps', () => {
    const r = resolveCastSpot(q({ nearRig: () => ({}), nearWeed: () => ({}), nearHotspot: () => ({ fr: 0.5 }) }), 0, 0, 'Offshore');
    expect(r).toEqual({ zone: 'Oil Rig', hs: { fr: 0.5 }, kind: 'rig' });
  });
});

describe('what the override unlocks', () => {
  const tally = (zone: string, hotspot: boolean): Record<string, number> => {
    const rng = xoshiro128ss(12345);
    const out: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) {
      const k = chooseFish(zone, { x: 0, z: 0 }, { hotspot, hump: null }, rng).key;
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };

  it('weedline and rig tables hold species no other zone has, and casts there can land them', () => {
    for (const zone of ['Weedline', 'Oil Rig']) {
      const elsewhere = new Set(Object.entries(ZONE_TABLE).filter(([z]) => z !== zone).flatMap(([, t]) => t.map(([k]) => k)));
      const unique = ZONE_TABLE[zone].map(([k]) => k).filter((k) => !elsewhere.has(k));
      const got = tally(zone, true);
      for (const k of unique) expect(got[k] ?? 0, zone + ' ' + k).toBeGreaterThan(0);
    }
  });

  it('a hotspot cast shifts the mix toward rare entries', () => {
    const rare = (m: Record<string, number>): number => (m['sailfish'] ?? 0) + (m['wahoo'] ?? 0) + (m['tripletail'] ?? 0) + (m['graytrigger'] ?? 0);
    expect(rare(tally('Weedline', true))).toBeGreaterThan(rare(tally('Weedline', false)));
  });
});
