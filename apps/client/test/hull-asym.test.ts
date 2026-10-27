/**
 * The catamaran sponsons are asymmetric.
 *
 * This is the difference between a performance cat and two pontoons, and it is invisible from the
 * deck — the hulls are under water — so it gets asserted on the geometry rather than looked at.
 * A real offshore cat carries a near-vertical inboard wall and much flatter inboard bottom, so
 * the inner faces plane and throw spray outward instead of into the tunnel.
 */
import { describe, expect, it } from 'vitest';
import { buildHullGeo, hullStation } from '../src/entities/boat/hull.js';
import { HULLS } from '@keysrun/shared/content/boats';

const H = HULLS.freeman;
const L = 12.8, B = 3.58;
/** The sponson spec model.ts lofts, minus the x offset so the section sits about zero. */
const Hs = { ...H, F: H.tunnel! + 0.2, spring: 0.16, entry: 0.4, dr0: H.dr0 + 4, dr1: H.dr1 };
const Bs = B * 0.29;

/** Lowest hull point on each side of the section at `z`, i.e. the keel/chine profile. */
function sideExtents(geo: ReturnType<typeof buildHullGeo>): { minX: number; maxX: number; loL: number; loR: number } {
  const p = geo.getAttribute('position');
  let minX = Infinity, maxX = -Infinity, loL = Infinity, loR = Infinity;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (x < -Bs * 0.22 && y < loL) loL = y;
    if (x > Bs * 0.22 && y < loR) loR = y;
  }
  return { minX, maxX, loL, loR };
}

describe('asymmetric catamaran sponsons', () => {
  it('is mirror-symmetric without the option, and not with it', () => {
    const sym = sideExtents(buildHullGeo(Hs, L, Bs, {}));
    // A symmetric loft reaches the same depth either side of its own centreline.
    expect(Math.abs(sym.loL - sym.loR)).toBeLessThan(1e-6);

    const asym = sideExtents(buildHullGeo(Hs, L, Bs, { asym: { side: -1, k: 0.34 } }));
    expect(Math.abs(asym.loL - asym.loR), 'the two halves should differ').toBeGreaterThan(0.01);
  });

  it('flattens the INBOARD half, not the outboard one', () => {
    // `side: -1` makes the -x half inboard. Flattening the inboard bottom pulls its chine down
    // toward the keel, so that half's lowest-but-off-centre point sits LOWER than the outboard's.
    const a = sideExtents(buildHullGeo(Hs, L, Bs, { asym: { side: -1, k: 0.34 } }));
    expect(a.loL, 'inboard chine should be nearer the keel').toBeLessThan(a.loR);

    // ...and it mirrors cleanly for the other sponson.
    const b = sideExtents(buildHullGeo(Hs, L, Bs, { asym: { side: 1, k: 0.34 } }));
    expect(b.loR).toBeLessThan(b.loL);
    expect(a.loL).toBeCloseTo(b.loR, 9);
  });

  it('does not change the sponson\'s beam', () => {
    const sym = sideExtents(buildHullGeo(Hs, L, Bs, {}));
    const asym = sideExtents(buildHullGeo(Hs, L, Bs, { asym: { side: -1, k: 0.34 } }));
    expect(asym.minX).toBeCloseTo(sym.minX, 6);
    expect(asym.maxX).toBeCloseTo(sym.maxX, 6);
  });

  it('keeps the sponsons slim and the tunnel wide', () => {
    // Most of a cat's beam is tunnel; that is where the ride comes from. Two sponsons at 0.29 B
    // leave 42% of the beam between them.
    const tunnelFrac = 1 - 2 * 0.29;
    expect(tunnelFrac).toBeGreaterThan(0.35);
    // And the forefoot is fine, not blunt.
    expect(Hs.entry).toBeLessThan(H.entry);
    expect(hullStation(Hs, L, Bs, 0.98).b).toBeLessThan(hullStation(H, L, Bs, 0.98).b);
  });
});
