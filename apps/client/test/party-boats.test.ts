/**
 * Where the moored party boats end up (src/entities/life/party-boats.ts).
 *
 * This is the test the module's "sites are found, not typed in" design exists for: a hand-typed
 * z that was fine when it was written is one terrain tweak away from putting a boat in a mangrove
 * or aground on a flat, and nobody would notice from the cockpit until they idled past it.
 * `findAnchorage` is pure and uses the real world functions, so this asserts the actual result
 * rather than the intent.
 */
import { describe, expect, it } from 'vitest';
import { depthAt, landH } from '@keysrun/shared/world/depth';
import { shoreInfo } from '@keysrun/shared/world/chain';
import { findAnchorage, PARTY_ANCHORAGES } from '../src/entities/life/party-boats.js';

describe('the anchorages', () => {
  it('every one of them is findable', () => {
    for (const a of PARTY_ANCHORAGES) {
      expect(findAnchorage(a.x, a.dir, a.startDz), a.name).not.toBeNull();
    }
  });

  it('puts every boat in water deep enough to float and not on land', () => {
    for (const a of PARTY_ANCHORAGES) {
      const p = findAnchorage(a.x, a.dir, a.startDz)!;
      // Checked across the whole raft-up, not just the first hull — boats are offset alongside.
      for (let i = 0; i < a.boats.length; i++) {
        const x = p.x + i * 5.2, z = p.z + i * 1.4;
        expect(landH(x, z), `${a.name} boat ${i} is on land`).toBeLessThanOrEqual(0.2);
        expect(depthAt(x, z), `${a.name} boat ${i} depth`).toBeGreaterThan(1.5);
      }
    }
  });

  it('puts them next to a shore, which is the whole point', () => {
    for (const a of PARTY_ANCHORAGES) {
      const p = findAnchorage(a.x, a.dir, a.startDz)!;
      const d = shoreInfo(p.x, p.z).d;
      expect(d, `${a.name} too close to the beach to swing`).toBeGreaterThan(20);
      expect(d, `${a.name} is out in open water, not tied up off a shore`).toBeLessThan(160);
    }
  });

  it('is off the island its name claims, not whichever shoreline happened to be nearer', () => {
    // The failure this catches: `chainZ(x)` sits inside Vaca Key for most of the chart, so a
    // search started there walks out to Vaca's own beach and every anchorage silently collapses
    // onto the same stretch of Marathon. That is exactly what the first version of this did.
    for (const a of PARTY_ANCHORAGES) {
      const p = findAnchorage(a.x, a.dir, a.startDz)!;
      expect(shoreInfo(p.x, p.z).isl?.name, a.name).toBe(a.isl);
    }
  });

  it('searches the side of its island it was asked to', () => {
    for (const a of PARTY_ANCHORAGES) {
      const p = findAnchorage(a.x, a.dir, a.startDz)!;
      expect(Math.sign(p.z - (0.000012 * a.x * a.x + a.startDz)), a.name).toBe(a.dir);
    }
  });

  it('is a short list — four boats, three anchorages', () => {
    // "Not too many of them" is a requirement, not a detail: these are full `makeBoat` hulls with
    // their own deck parties, and they are supposed to be something you come across.
    expect(PARTY_ANCHORAGES).toHaveLength(3);
    expect(PARTY_ANCHORAGES.reduce((n, a) => n + a.boats.length, 0)).toBe(4);
  });

  it('reports no anchorage rather than a bad one when a stretch has nowhere suitable', () => {
    // Far out in the Straits: no shoreline within the search band at all.
    expect(findAnchorage(0, 1, 2600)).toBeNull();
  });
});
