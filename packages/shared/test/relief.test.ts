import { describe, expect, it } from 'vitest';
import { depthAt, WB } from '../src/world/depth.js';
import { chainZ } from '../src/world/chain.js';
import { reliefAt, floorDepthAt, RELIEF_MIN_TOP } from '../src/world/relief.js';

const sample = (x0: number, x1: number, z0: number, z1: number, step: number): Array<[number, number, number]> => {
  const out: Array<[number, number, number]> = [];
  for (let z = z0; z <= z1; z += step) for (let x = x0; x <= x1; x += step) out.push([x, z, depthAt(x, z)]);
  return out;
};

describe('seafloor relief', () => {
  it('is deterministic and finite', () => {
    for (const [x, z, d] of sample(-3000, 3000, -500, 3500, 211)) {
      const a = reliefAt(x, z, d), b = reliefAt(x, z, d);
      expect(Number.isFinite(a)).toBe(true);
      expect(a).toBe(b);
    }
  });

  it('never brings the floor within RELIEF_MIN_TOP of the surface, nor above 70% of the depth', () => {
    let worst = Infinity;
    for (const [x, z, d] of sample(WB.x0, WB.x1, WB.z0, WB.z1, 97)) {
      const floor = floorDepthAt(x, z, d);
      if (d >= RELIEF_MIN_TOP) worst = Math.min(worst, floor);
      expect(floor).toBeGreaterThanOrEqual(Math.min(d, RELIEF_MIN_TOP) - 1e-9);
      expect(floor).toBeGreaterThanOrEqual(0.3 * d - 1e-9);
    }
    expect(worst).toBeGreaterThanOrEqual(RELIEF_MIN_TOP - 1e-9);
  });

  it('is exactly zero in the bay, the flats and the bridge cuts (dz < 150 or d < 2.6)', () => {
    for (const [x, z, d] of sample(-3500, 3500, -2800, 5000, 83)) {
      const dz = z - chainZ(x);
      if (dz < 150 || d < 2.6) expect(reliefAt(x, z, d)).toBe(0);
    }
  });

  it('grooves never dig deeper than 1.1 m', () => {
    for (const [x, z, d] of sample(-2500, 2500, 1200, 1800, 37)) expect(reliefAt(x, z, d)).toBeGreaterThanOrEqual(-1.1 - 1e-9);
  });

  it('the reef front genuinely has relief: >1.5 m of spur-and-groove along a depth contour, and rocks standing >2 m', () => {
    // walk along the chain at fixed dz on the reef front and record the floor deviation
    let lo = Infinity, hi = -Infinity;
    for (let x = -1000; x <= -400; x += 2) {
      const z = chainZ(x) + 1380, d = depthAt(x, z);
      const r = reliefAt(x, z, d);
      lo = Math.min(lo, r); hi = Math.max(hi, r);
    }
    expect(hi - lo).toBeGreaterThan(1.5);
    let tall = 0;
    for (const [x, z, d] of sample(-2500, 2500, 1150, 1700, 9)) if (reliefAt(x, z, d) > 2) tall++;
    expect(tall).toBeGreaterThan(20);
  });

  it('the open flats stay flat while the reef is rough (relief spread by zone)', () => {
    const spread = (z0: number, z1: number, x0 = -2500, x1 = 2500): number => {
      let s = 0, s2 = 0, n = 0;
      for (const [x, z, d] of sample(x0, x1, z0, z1, 13)) { const r = reliefAt(x, z, d); s += r; s2 += r * r; n++; }
      return Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
    };
    const reefSd = spread(1350, 1650);
    const hawkSd = spread(450, 1050);
    expect(reefSd).toBeGreaterThan(0.5);
    expect(hawkSd).toBeLessThan(reefSd * 0.7);
  });

  it('has a bounded slope: a ledge is a ledge, not a needle (< 2.0 m/m over 2 m)', () => {
    let maxSlope = 0;
    for (let z = 1250; z < 1700; z += 6) {
      for (let x = -1500; x < 1500; x += 6) {
        const h = (xx: number, zz: number): number => -(depthAt(xx, zz) - reliefAt(xx, zz, depthAt(xx, zz)));
        const g = Math.max(Math.abs(h(x + 2, z) - h(x, z)), Math.abs(h(x, z + 2) - h(x, z))) / 2;
        maxSlope = Math.max(maxSlope, g);
      }
    }
    expect(maxSlope).toBeLessThan(2.0);
  });

  it('leaves depthAt alone: the relief is a separate layer (buoys, boats, party boats read depthAt)', () => {
    // a point on a known outcrop-rich stretch: depthAt equals the unmodified closed form's value
    // (pinned from the pre-relief implementation) while the floor differs.
    const x = -700, z = chainZ(x) + 1390;
    const d = depthAt(x, z);
    expect(floorDepthAt(x, z, d)).not.toBe(d);
    expect(d).toBeCloseTo(4.5591218124642605, 10); // value from the unmodified depthAt
  });
});
