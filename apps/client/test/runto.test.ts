/**
 * Every "Run to" destination has to be somewhere a boat can actually be.
 *
 * The list is derived from the world data rather than typed out, which is what keeps it honest —
 * but derived wrongly is still wrong, and the failure mode is putting the hull on a flat or
 * inside a rig. `findClearSpot` arbitrates at runtime, yet it can only search outward from what
 * it is given: hand it dry land and it hands back the nearest water, which may be nowhere near
 * the name the player pressed.
 */
import { describe, it, expect } from 'vitest';
import { destinations } from '../src/ui/runto.js';
import { depthAt, landH, WB } from '@keysrun/shared/world/depth';
import { BOATS } from '@keysrun/shared/content/boats';

const DEEPEST_DRAFT = Math.max(...BOATS.map((b) => b.draft));

describe('run-to destinations', () => {
  const all = destinations().flatMap((g) => g.items.map((d) => ({ ...d, group: g.group })));

  it('offers both the docks and the spots, with no duplicates', () => {
    expect(all.length).toBeGreaterThanOrEqual(9);
    expect(destinations().map((g) => g.group)).toEqual(['Back to the dock', 'Fishing spots']);
    expect(new Set(all.map((d) => d.name)).size).toBe(all.length);
  });

  it('every one is inside the sailable box', () => {
    for (const d of all) {
      expect(d.x, d.name).toBeGreaterThanOrEqual(WB.x0);
      expect(d.x, d.name).toBeLessThanOrEqual(WB.x1);
      expect(d.z, d.name).toBeGreaterThanOrEqual(WB.z0);
      expect(d.z, d.name).toBeLessThanOrEqual(WB.z1);
    }
  });

  it('every one is in water, not on made ground', () => {
    for (const d of all) expect(landH(d.x, d.z), `${d.name} is on dry land`).toBeLessThan(0);
  });

  it('every one floats the deepest hull in the game', () => {
    const report: string[] = [];
    for (const d of all) {
      const dep = depthAt(d.x, d.z);
      report.push(`${d.name.padEnd(28)} ${dep.toFixed(1)} m`);
      expect(dep, `${d.name} is only ${dep.toFixed(2)} m deep`).toBeGreaterThan(DEEPEST_DRAFT + 0.3);
    }
    console.log(`  deepest draft afloat is ${DEEPEST_DRAFT} m:\n   ` + report.join('\n   '));
  });
});
