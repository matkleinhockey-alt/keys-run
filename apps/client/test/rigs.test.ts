/**
 * The rig field: every site has to be somewhere a rig can actually stand, and no two may be
 * stacked on top of each other.
 *
 * `spawnRigs` skips any site in under 20 m of water *silently* — it just returns early and no
 * structure appears — so a site placed on a shoal is not a visible error, it is a rig that
 * quietly does not exist. That is exactly the kind of thing worth a test rather than an eyeball.
 */
import { describe, expect, it } from 'vitest';
import { depthAt } from '@keysrun/shared/world/depth';
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

  it('keeps the platforms far enough apart to read as separate structures', () => {
    for (let i = 0; i < RIG_SITES.length; i++) {
      for (let j = i + 1; j < RIG_SITES.length; j++) {
        const [ax, adz] = RIG_SITES[i], [bx, bdz] = RIG_SITES[j];
        const sep = Math.hypot(ax - bx, siteZ(ax, adz) - siteZ(bx, bdz));
        expect(sep, `sites ${i} and ${j}`).toBeGreaterThan(600);
      }
    }
  });

  it('is a mixed field, not one structure repeated', () => {
    const kinds = new Set<RigKind>(RIG_SITES.map(([, , k]) => k));
    expect(kinds.size).toBeGreaterThanOrEqual(3);
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
