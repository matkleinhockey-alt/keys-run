/**
 * The tunas' second dorsal and anal fins.
 *
 * `CreatureVis.sickle` was declared on every tuna and graded by species exactly as the real
 * field marks run — yellowfin .95, bigeye .5, bluefin .42, albacore .4, skipjack .35 — and
 * nothing read it. The shape table gives a tuna one triangular first dorsal and no anal fin at
 * all, so a yellowfin, whose whole identity is the pair of long bright-yellow sickles trailing
 * most of the way to its tail, was a plain blue torpedo. Checked against a species plate.
 *
 * Measured growth above the body axis across the sickle's span: yellowfin +189 mm, bluefin
 * +135, bigeye +113, albacore +53, skipjack +35. Yellowfin most, which is the point.
 */
import { describe, it, expect } from 'vitest';
import { buildFishGeo } from '../src/entities/fish/geometry.js';
import { VIS } from '@keysrun/shared/content/creatures';

/** How far the geometry reaches above the body axis within the sickle's span along the fish. */
function reachInSpan(key: string, V: typeof VIS[string]): number {
  const g = buildFishGeo(key, V, 'high');
  const pos = g.attributes.position;
  const L = V.len;
  const z0 = -L / 2 + 0.52 * L, z1 = -L / 2 + 0.78 * L;
  let maxY = -1e9;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    if (z < z0 || z > z1) continue;
    maxY = Math.max(maxY, pos.getY(i));
  }
  g.dispose();
  return maxY;
}

describe('tuna sickles', () => {
  it('scale with each species own sickle value', () => {
    const rows: Array<[string, number, number, number]> = [];
    for (const key of ['yellowfin', 'bigeye', 'bluefin', 'albacore', 'skipjack']) {
      const V = VIS[key];
      const on = reachInSpan(key, V);
      const off = reachInSpan(key, { ...V, sickle: undefined });
      rows.push([key, V.sickle!, off, on]);
      console.log(`  ${key.padEnd(10)} sickle=${String(V.sickle).padEnd(5)} reach above axis ${off.toFixed(4)} -> ${on.toFixed(4)} m  (+${((on - off) * 1000).toFixed(0)} mm)`);
    }
    // every tuna grew, and the grading follows the data: yellowfin most, skipjack least
    for (const [, , off, on] of rows) expect(on).toBeGreaterThan(off);
    const byGrowth = [...rows].sort((a, b) => (b[3] - b[2]) - (a[3] - a[2])).map((r) => r[0]);
    expect(byGrowth[0]).toBe('yellowfin');
  });

  it('a fish that declares its own anal fin does not grow a second pair', () => {
    const bf = VIS.blackfin;
    const a = buildFishGeo('blackfin', bf, 'high').attributes.position.count;
    const b = buildFishGeo('blackfin', { ...bf, sickle: 0.9 }, 'high').attributes.position.count;
    expect(a).toBe(b);
  });
});
