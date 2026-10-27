/**
 * The flatfish: flounder, sole and halibut.
 *
 * A flatfish is not a fish that happens to be near the bottom — it is an animal lying on its
 * side ON it, with both eyes migrated to the upper flank and an unpigmented blind underside.
 * The renderer gets all of that from two flags (`flat` rolls the body 90 degrees, `level`
 * keeps it down there), so this pins the flags rather than the rendering.
 */
import { describe, expect, it } from 'vitest';
import { VIS, ZONE_LIFE } from '../src/content/creatures.js';
import { SPECIES, ZONE_TABLE } from '../src/content/species.js';

const FLATFISH = ['flounder', 'sole', 'halibut'] as const;

describe('flatfish', () => {
  it('lies flat, on the bottom, with a blind white underside', () => {
    for (const k of FLATFISH) {
      const V = VIS[k];
      expect(V, k).toBeDefined();
      expect(V.flat, `${k} should lie on its side`).toBe(true);
      expect(V.level, `${k} lives on the bottom`).toBe('bottom');
      // Authored deep and very thin — that is a flatfish seen head-on, before `flat` lays it over.
      expect(V.h / V.w, `${k} should be far deeper than it is wide`).toBeGreaterThan(4);
      // The underside is the blind side and carries no pigment.
      const belly = parseInt(V.belly.slice(1), 16);
      const lum = ((belly >> 16 & 255) + (belly >> 8 & 255) + (belly & 255)) / 3;
      expect(lum, `${k}'s blind side should be near-white`).toBeGreaterThan(210);
    }
  });

  it('spans a real size range, from a sole you could palm to a halibut you could not lift', () => {
    expect(SPECIES.sole.max).toBeLessThan(10);
    // Atlantic halibut is the largest flatfish there is; the rod record is over 400 lb and they
    // are caught at a few pounds, so the spread is wide and honest.
    expect(SPECIES.halibut.min).toBeLessThanOrEqual(3);
    expect(SPECIES.halibut.max).toBeGreaterThanOrEqual(400);
    expect(SPECIES.halibut.max / SPECIES.flounder.max).toBeGreaterThan(10);
    for (const k of FLATFISH) expect(SPECIES[k].max).toBeGreaterThan(SPECIES[k].min);
  });

  it('puts each one where it belongs, inshore or deep', () => {
    const inLife = (z: string, k: string): boolean => (ZONE_LIFE[z] ?? []).some(([n]) => n === k);
    const inRod = (z: string, k: string): boolean => (ZONE_TABLE[z] ?? []).some(([n]) => n === k);
    // Sole and flounder are estuarine: creeks, flats, the backcountry.
    for (const z of ['Creek', 'Flats', 'Backcountry']) {
      expect(inLife(z, 'sole'), `sole in ${z}`).toBe(true);
      expect(inLife(z, 'flounder'), `flounder in ${z}`).toBe(true);
    }
    // ...and a halibut is a deep cold-water animal, so it is never on the flats.
    expect(inLife('Offshore', 'halibut')).toBe(true);
    expect(inLife('Flats', 'halibut')).toBe(false);
    expect(inLife('Creek', 'halibut')).toBe(false);
    // All three are catchable on the rod somewhere.
    for (const k of FLATFISH) {
      expect(Object.keys(ZONE_TABLE).some((z) => inRod(z, k)), `${k} catchable`).toBe(true);
    }
  });

  it('keeps them solitary, the way an ambush predator on sand is', () => {
    for (const k of FLATFISH) expect(VIS[k].school[1], k).toBeLessThanOrEqual(3);
  });
});
