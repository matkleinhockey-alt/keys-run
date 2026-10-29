/**
 * world/piers.ts: the public fishing piers stand where a pier can stand — off the land into
 * fishing water, joined to the ground within a step, clear of both bridges, the town and the
 * marinas — and they are the same for everyone.
 */
import { describe, expect, it } from 'vitest';
import { PIERS, PIER_TOP, HEAD_D, pierAt, pierGround, pierBerth } from '../src/world/piers.js';
import { landH, depthAt, MARINAS, OLDBR } from '../src/world/depth.js';
import { chainZ } from '../src/world/chain.js';
import { inTownFootprint } from '../src/world/town.js';
import { STEP_MAX } from '../src/sim/walker.js';

describe('fishing piers', () => {
  it('there are several, each with its own name', () => {
    expect(PIERS.length).toBeGreaterThanOrEqual(4);
    expect(new Set(PIERS.map((p) => p.name)).size).toBe(PIERS.length);
    for (const p of PIERS) expect(p.name).toMatch(/Fishing Pier$/);
  });

  it('start on the ground within a step of the deck, and end over fishing water', () => {
    for (const p of PIERS) {
      expect(Math.abs(landH(p.x0, p.z0) - PIER_TOP), p.name).toBeLessThanOrEqual(STEP_MAX);
      expect(depthAt(p.x1, p.z1), p.name).toBeGreaterThanOrEqual(2); // the T is 10 m past the first 2.4 m of water
      expect(pierGround(p.x1, p.z1)).toBe(PIER_TOP);
      expect(pierAt(p.x0 + p.nx * (p.len / 2), p.z0 + p.nz * (p.len / 2))).toBe(p);
    }
  });

  it('keep clear of both bridges, the town and the marinas', () => {
    for (const p of PIERS) {
      for (let a = 0; a <= p.len + HEAD_D / 2; a += 2) {
        const x = p.x0 + p.nx * a, z = p.z0 + p.nz * a;
        expect(Math.abs(z - chainZ(x)), `${p.name} under US-1 at ${a} m`).toBeGreaterThan(9);
        if (x > OLDBR.x0 - 10 && x < OLDBR.x1 + 10) expect(Math.abs(z - chainZ(x) - OLDBR.dz), `${p.name} under the old bridge`).toBeGreaterThan(9);
        expect(inTownFootprint(x, z)).toBe(false);
      }
      for (const m of MARINAS) expect(Math.hypot(m.sx - p.x0, m.sz - p.z0)).toBeGreaterThan(200);
    }
  });

  it('are somewhere to tie up: a berth on the deck beside a boat off the T', () => {
    for (const p of PIERS) {
      const b = pierBerth(p.x1 + p.nx * 7, p.z1 + p.nz * 7, 14);
      expect(b?.pier, p.name).toBe(p);
      expect(pierGround(b!.x, b!.z)).toBe(PIER_TOP);
    }
  });
});
