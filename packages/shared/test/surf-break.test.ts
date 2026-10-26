/**
 * The surf break: the one place inshore where shallow means rougher, not calmer.
 *
 * `ampFor` grows with depth, so everywhere else the flats are glass and the open stream has the
 * rollers. That is right for the Keys and wrong for a beach — swell shoals and steepens as the
 * bottom comes up under it. This pins the break being genuinely rougher than the water around
 * it, and staying local instead of leaking out over the whole bay.
 */
import { describe, expect, it } from 'vitest';
import { SURF_BREAK, depthAt } from '../src/world/depth.js';
import { ampAt, inletAt, INLET_MAX } from '../src/sim/depth-grid.js';

const { x, z, r } = SURF_BREAK;
/** Ordinary inshore water, well away from any cut or the break. */
const FLATS = ampAt(-900, 700);

describe('the surf break', () => {
  it('stands in water you could actually surf, not on the beach or out in the deep', () => {
    const d = depthAt(x, z);
    expect(d).toBeGreaterThan(1.1);
    expect(d).toBeLessThan(9);
  });

  it('is markedly rougher than the flats around it', () => {
    expect(ampAt(x, z)).toBeGreaterThan(FLATS * 4);
  });

  it('fades out instead of roughening the whole bay', () => {
    // Well outside the radius it must be indistinguishable from ordinary water.
    for (const d of [r * 1.6, r * 2.5]) {
      expect(ampAt(x, z + d), `${d.toFixed(0)} m offshore`).toBeLessThan(FLATS * 2.2);
      expect(inletAt(x, z + d)).toBe(0);
    }
  });

  it('is roughest at its middle and falls away from there', () => {
    const a0 = ampAt(x, z), a1 = ampAt(x, z + r * 0.4), a2 = ampAt(x, z + r * 0.8);
    expect(a0).toBeGreaterThan(a1);
    expect(a1).toBeGreaterThan(a2);
  });

  it('keeps the field inside the ceiling the depth texture is packed against', () => {
    // water.ts packs inlet as inlet/INLET_MAX into a byte; anything above this would clip there
    // and the shader would quietly disagree with the physics about how big the waves are.
    for (let dx = -r; dx <= r; dx += 25) {
      for (let dz = -r; dz <= r; dz += 25) {
        expect(inletAt(x + dx, z + dz)).toBeLessThanOrEqual(INLET_MAX);
      }
    }
  });

  it('leaves the tidal inlets along the chain alone', () => {
    // The cuts between the keys are the original use of this field and must be unchanged.
    // A cut on the chain, a long way from the break (measured: inlet 0.65 at 3.1 m).
    expect(inletAt(-1850, 11)).toBeGreaterThan(0.3);
    expect(inletAt(-1850, 11)).toBeLessThanOrEqual(1);
  });
});
