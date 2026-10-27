/**
 * The fish you go to a place for, and the fish that leaves the water.
 *
 * Two pieces of Keys fishing identity that the tables merely allowed rather than expressed: a
 * flat is a BONEFISH flat, and the bridges are where you go for TARPON. Both were already the
 * top entry in their zone, which is not the same as being the reason you are there.
 */
import { describe, expect, it } from 'vitest';
import { ZONE_TABLE } from '../src/content/species.js';
import { fightParamsFor } from '../src/sim/fight.js';
import { SPECIES } from '../src/content/species.js';

const share = (zone: string, key: string): number => {
  const t = ZONE_TABLE[zone];
  const total = t.reduce((a, [, w]) => a + w, 0);
  return (t.find(([k]) => k === key)?.[1] ?? 0) / total;
};

describe('signature fish of a place', () => {
  it('makes the flats about bonefish', () => {
    expect(share('Flats', 'bonefish')).toBeGreaterThan(0.35);
    // ...and keeps them off every other zone's card: a bonefish on a reef is a bug, not a bonus.
    for (const z of Object.keys(ZONE_TABLE)) {
      if (z !== 'Flats') expect(ZONE_TABLE[z].some(([k]) => k === 'bonefish'), z).toBe(false);
    }
  });

  it('makes the bridges about tarpon', () => {
    expect(share('Bridge', 'tarpon')).toBeGreaterThan(0.35);
    // Tarpon still turn up elsewhere — they are everywhere in these waters — just not like this.
    for (const z of ['Creek', 'Flats', 'Backcountry', 'Hawk Channel']) {
      expect(share(z, 'tarpon'), z).toBeGreaterThan(0);
      expect(share(z, 'tarpon'), z).toBeLessThan(0.2);
    }
  });
});

describe('jump height', () => {
  const tackle = { lineLb: 30, leaderLb: 40, spool: 1, drag: 1 } as never;
  const heightOf = (key: string, frac = 0.8): number => {
    const S = SPECIES[key];
    return fightParamsFor(key, S.min + (S.max - S.min) * frac, 0.5, tackle).jumpHeightM;
  };

  it('puts the tarpon above everything that swims here', () => {
    const tarpon = heightOf('tarpon');
    for (const k of ['mahi', 'snook', 'kingfish', 'jackcrevalle', 'sailfish', 'ladyfish', 'barracuda']) {
      expect(tarpon, `tarpon vs ${k}`).toBeGreaterThan(heightOf(k));
    }
    expect(tarpon, 'a tarpon should genuinely clear the water').toBeGreaterThan(2.4);
  });

  it('lifts a big fish higher than a small one of the same species, but not in proportion', () => {
    const small = heightOf('tarpon', 0), big = heightOf('tarpon', 1);
    expect(big).toBeGreaterThan(small);
    // It is throwing a much heavier body: the gain is gentle and capped, not linear in weight.
    expect(big / small).toBeLessThan(1.8);
  });

  it('gives everything that can jump a height, jumper or not', () => {
    for (const k of Object.keys(SPECIES)) {
      const S = SPECIES[k];
      const h = fightParamsFor(k, (S.min + S.max) / 2, 0.5, tackle).jumpHeightM;
      expect(h, k).toBeGreaterThan(0);
    }
  });
});
