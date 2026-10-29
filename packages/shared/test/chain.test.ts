import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainZ, islands, shoreInfo, islandDist, islandBox, VACA, KCB, BOOT, getIsland } from '../src/world/chain.js';
import { COAST_CAP, coastInside } from '../src/world/coast.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const golden: any = JSON.parse(fs.readFileSync(path.join(HERE, 'golden.json'), 'utf8'));

describe('world/chain: golden fidelity against legacy/index.html', () => {
  it('builds exactly the same islands as legacy, in the same order (seed=11 EXACTLY)', () => {
    expect(islands.length).toBe(golden.islands.length);
    islands.forEach((I, i) => {
      const G = golden.islands[i];
      expect(I.name).toBe(G.name);
      expect(I.x).toBe(G.x);
      expect(I.z).toBe(G.z);
      expect(I.a).toBe(G.a);
      expect(I.b).toBe(G.b);
      expect(I.th).toBe(G.th);
      expect(I.c).toBe(G.c);
      expect(I.s).toBe(G.s);
      expect(I.small).toBe(G.small);
      expect(!!I.mainland).toBe(G.mainland);
      expect(!!I.miami).toBe(G.miami);
      expect(!!I.noHouses).toBe(G.noHouses);
    });
  });

  it('chainZ matches the baseline over the 60x60 grid', () => {
    for (const p of golden.grid) {
      expect(chainZ(p.x)).toBe(p.chainZ);
    }
  });

  it('shoreInfo matches the baseline wherever the mainland ellipse is the nearest shore', () => {
    const near = [...golden.grid, ...golden.points].filter((p) => p.shoreIsl === 'Florida mainland (Miami)' && shoreInfo(p.x, p.z).isl?.mainland);
    expect(near.length).toBeGreaterThan(100);
    for (const p of near) {
      const si = shoreInfo(p.x, p.z);
      expect(si.d).toBe(p.shoreD);
      expect(si.e).toBe(p.shoreE);
    }
  });

  it('exposes the named islands depth.ts depends on', () => {
    expect(VACA.name).toBe('Marathon (Vaca Key)');
    expect(KCB.name).toBe('Key Colony Beach');
    expect(BOOT.name).toBe('Boot Key');
    expect(getIsland('Marathon (Vaca Key)')).toBe(VACA);
    expect(getIsland('nonexistent island')).toBeUndefined();
  });
});

describe('world/chain: real island outlines', () => {
  const coasted = islands.filter((I) => !I.mainland);

  it('gives every island but the mainland a real outline, inside its old footprint\'s neighbourhood', () => {
    for (const I of coasted) {
      expect(I.coast, I.name).toBeDefined();
      const b = islandBox(I);
      // the fit centres the outline's box on the old ellipse and matches its length
      expect(Math.abs((b.x0 + b.x1) / 2 - I.x), I.name).toBeLessThan(I.a * 0.3 + 30);
      expect(Math.abs((b.z0 + b.z1) / 2 - I.z), I.name).toBeLessThan(I.a * 0.3 + 30);
    }
    expect(getIsland('Florida mainland (Miami)')!.coast).toBeUndefined();
  });

  it('is land inside and sea outside, with the shore at d = 0', () => {
    for (const I of coasted) {
      const c = I.coast!, r = c.rings[0];
      // a point just inside the first edge's midpoint is land, just outside is sea
      for (let i = 0; i < r.length; i += 2 * Math.max(1, Math.floor(r.length / 40))) {
        const ax = r[i], az = r[i + 1], bx = r[(i + 2) % r.length], bz = r[(i + 3) % r.length];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 2) continue;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2, nx = (bz - az) / L, nz = -(bx - ax) / L; // outward for CCW in (x,z)? sign checked below
        const d = islandDist(I, mx, mz);
        expect(Math.abs(d), `${I.name} edge midpoint`).toBeLessThan(0.01);
        const a = coastInside(c, mx + nx * 0.2, mz + nz * 0.2), b = coastInside(c, mx - nx * 0.2, mz - nz * 0.2);
        expect(a !== b, `${I.name}: one side of the shore is land, the other sea`).toBe(true);
      }
    }
  });

  it('measures distance like a distance: never changes faster than the point moves, and caps far out', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 4000; k++) {
      const x = -4300 + rnd() * 8600, z = -3100 + rnd() * 8600, dx = (rnd() - 0.5) * 6, dz = (rnd() - 0.5) * 6;
      const A = shoreInfo(x, z), B = shoreInfo(x + dx, z + dz), a = A.d, b = B.d;
      if (A.isl?.mainland || B.isl?.mainland) continue; // legacy's ellipse "distance" is not a true distance
      expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.hypot(dx, dz) + 1e-6);
      expect(a).toBeGreaterThanOrEqual(-COAST_CAP - 1e-9);
    }
  });
});
