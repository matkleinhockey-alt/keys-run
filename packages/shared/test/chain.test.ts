import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainZ, islands, shoreInfo, VACA, KCB, BOOT, getIsland } from '../src/world/chain.js';

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

  it('chainZ matches legacy over the 60x60 golden grid', () => {
    for (const p of golden.grid) {
      expect(chainZ(p.x)).toBe(p.chainZ);
    }
  });

  it('shoreInfo matches legacy over the grid and every hand-picked point', () => {
    for (const p of [...golden.grid, ...golden.points]) {
      const si = shoreInfo(p.x, p.z);
      expect(si.d).toBe(p.shoreD);
      expect(si.e).toBe(p.shoreE);
      expect(si.isl ? si.isl.name : null).toBe(p.shoreIsl);
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
