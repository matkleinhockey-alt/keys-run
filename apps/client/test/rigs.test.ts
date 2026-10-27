/**
 * The rig field: every site has to be somewhere a rig can actually stand, and no two may be
 * stacked on top of each other.
 *
 * `spawnRigs` skips any site in under 20 m of water *silently* — it just returns early and no
 * structure appears — so a site placed on a shoal is not a visible error, it is a rig that
 * quietly does not exist. That is exactly the kind of thing worth a test rather than an eyeball.
 */
import { describe, expect, it } from 'vitest';
import { depthAt, WB } from '@keysrun/shared/world/depth';
import { chainZ } from '@keysrun/shared/world/chain';
import { RIG_SITES, type RigKind } from '../src/entities/life/hotspots.js';

const siteZ = (x: number, dz: number): number => chainZ(x) + dz;

describe('oil rig field', () => {
  it('stands every site in water deep enough that spawnRigs will not skip it', () => {
    for (const [x, dz, kind] of RIG_SITES) {
      const d = depthAt(x, siteZ(x, dz));
      expect(d, `${kind} at x=${x} dz=${dz} is in ${d.toFixed(1)} m`).toBeGreaterThanOrEqual(20);
    }
  });

  it('puts every site somewhere the boat can actually get to', () => {
    // `WB` is the box the boat is clamped to. A rig outside it still gets built and drawn, so
    // the failure is silent and infuriating: you steer at a platform on the horizon and stop
    // dead on an invisible wall several hundred metres short of it. One site was in exactly
    // that state (x -4400 against a -4150 limit) from the day the field was laid out.
    const MARGIN = 120;   // room to run round the structure once you are there
    for (const [x, dz, kind] of RIG_SITES) {
      const z = siteZ(x, dz);
      expect(x, `${kind} at x=${x} is outside the sailable world`).toBeGreaterThan(WB.x0 + MARGIN);
      expect(x, `${kind} at x=${x} is outside the sailable world`).toBeLessThan(WB.x1 - MARGIN);
      expect(z, `${kind} at z=${z.toFixed(0)} is outside the sailable world`).toBeGreaterThan(WB.z0 + MARGIN);
      expect(z, `${kind} at z=${z.toFixed(0)} is outside the sailable world`).toBeLessThan(WB.z1 - MARGIN);
    }
  });

  it('keeps the platforms far enough apart to read as separate structures', () => {
    for (let i = 0; i < RIG_SITES.length; i++) {
      for (let j = i + 1; j < RIG_SITES.length; j++) {
        const [ax, adz] = RIG_SITES[i], [bx, bdz] = RIG_SITES[j];
        const sep = Math.hypot(ax - bx, siteZ(ax, adz) - siteZ(bx, bdz));
        expect(sep, `sites ${i} and ${j}`).toBeGreaterThan(600);
      }
    }
  });

  it('only stands a bottom-founded structure where it could actually reach the bottom', () => {
    // Two different limits, and the first draft of this test wrongly used one number for both.
    //
    // A JACK-UP really is depth-limited: it floats to the site and then jacks its hull up its own
    // legs, so it can only work where its legs reach — roughly 120 m, 150 for the biggest units.
    // A fixed JACKET has no such ceiling; it is welded to the seabed and real ones have been
    // built past 400 m. So the tight bound belongs on jack-ups alone.
    //
    // Floaters are moored and have the opposite problem — they are what you use once standing on
    // the bottom stops being an option — so they belong offshore of the fixed row, not inside it.
    const JACKED: RigKind[] = ['jackup'];
    const FLOATING: RigKind[] = ['semisub', 'spar'];
    let shallowestFloater = Infinity;
    for (const [x, dz, kind] of RIG_SITES) {
      const d = depthAt(x, siteZ(x, dz));
      if (JACKED.includes(kind)) {
        expect(d, `${kind} at x=${x} would have to jack up through ${d.toFixed(0)} m`).toBeLessThan(150);
      }
      if (FLOATING.includes(kind)) shallowestFloater = Math.min(shallowestFloater, d);
    }
    // A spar in particular is the deep-water answer: put it in the deepest water in the field.
    const spars = RIG_SITES.filter(([, , k]) => k === 'spar');
    expect(spars.length).toBeGreaterThan(0);
    for (const [x, dz] of spars) expect(depthAt(x, siteZ(x, dz))).toBeGreaterThan(150);
    expect(shallowestFloater, 'no floater parked in the shallows').toBeGreaterThan(60);
  });

  it('is a mixed field, not one structure repeated', () => {
    const kinds = new Set<RigKind>(RIG_SITES.map(([, , k]) => k));
    expect(kinds.size).toBeGreaterThanOrEqual(5);
    // And no single kind dominates the whole field.
    for (const k of kinds) {
      expect(RIG_SITES.filter(([, , kk]) => kk === k).length).toBeLessThan(RIG_SITES.length);
    }
  });

  it('spreads the field along the chain rather than clustering it in one place', () => {
    const xs = RIG_SITES.map(([x]) => x).sort((a, b) => a - b);
    expect(xs[xs.length - 1] - xs[0]).toBeGreaterThan(6000);
  });
});
