import { describe, expect, it } from 'vitest';
import { chainZ } from '../src/world/chain.js';
import {
  chainNormal, chainTangent, currentAt, steadyCurrentAt, surgeAt, tidalExposure,
  GULF_MAX_SPEED, SURGE_DECAY_DEPTH, TIDE_PERIOD_S,
} from '../src/world/current.js';

/** A point `dz` metres seaward of the chain line at `x`. */
const at = (x: number, dz: number): [number, number] => [x, chainZ(x) + dz];

describe('chain axes', () => {
  it('tangent and normal are unit length and perpendicular', () => {
    for (const x of [-4000, -1000, 0, 1500, 4000]) {
      const { tx, tz } = chainTangent(x);
      const { nx, nz } = chainNormal(x);
      expect(Math.hypot(tx, tz)).toBeCloseTo(1, 10);
      expect(Math.hypot(nx, nz)).toBeCloseTo(1, 10);
      expect(tx * nx + tz * nz).toBeCloseTo(0, 10);
    }
  });

  it('runs due +x at the origin and bends toward +z to the east', () => {
    expect(chainTangent(0).tz).toBeCloseTo(0, 10);
    expect(chainTangent(4000).tz).toBeGreaterThan(0);
    // ...and symmetrically the other way to the west, since chainZ is a parabola.
    expect(chainTangent(-4000).tz).toBeLessThan(0);
  });

  it('normal points seaward (+z) along the whole chain', () => {
    for (const x of [-4000, 0, 4000]) expect(chainNormal(x).nz).toBeGreaterThan(0);
  });
});

describe('Florida Current', () => {
  it('is negligible inshore and strong offshore', () => {
    // Sampled at tidal slack (t=0) so only the gulf term contributes.
    const inshore = steadyCurrentAt(...at(0, 200), 0);
    const offshore = steadyCurrentAt(...at(0, 3900), 0);
    expect(inshore.speed).toBeLessThan(0.05);
    expect(offshore.speed).toBeGreaterThan(GULF_MAX_SPEED * 0.9);
  });

  it('flows up the Keys (+x), not back down', () => {
    expect(steadyCurrentAt(...at(0, 3900), 0).vx).toBeGreaterThan(0);
  });

  it('strengthens monotonically with distance offshore', () => {
    let prev = -1;
    for (const dz of [1700, 2200, 2800, 3400, 3900]) {
      const s = steadyCurrentAt(...at(0, dz), 0).speed;
      expect(s).toBeGreaterThan(prev);
      prev = s;
    }
  });
});

describe('tide', () => {
  it('reverses over a full period and is symmetric about slack', () => {
    const p = at(0, 300);
    const flood = steadyCurrentAt(...p, TIDE_PERIOD_S * 0.25);
    const ebb = steadyCurrentAt(...p, TIDE_PERIOD_S * 0.75);
    expect(flood.vx).toBeGreaterThan(0);
    expect(ebb.vx).toBeLessThan(0);
    expect(flood.vx).toBeCloseTo(-ebb.vx, 10);
  });

  it('concentrates inshore and vanishes out in the stream', () => {
    expect(tidalExposure(...at(0, 300))).toBeGreaterThan(0.8);
    expect(tidalExposure(...at(0, 3900))).toBeLessThan(0.02);
  });
});

describe('surge', () => {
  it('decays to nothing with depth', () => {
    const p = at(0, 1500);
    const shallow = surgeAt(...p, 1.9, 2);
    const deep = surgeAt(...p, 1.9, SURGE_DECAY_DEPTH * 5);
    expect(shallow.speed).toBeGreaterThan(0.1);
    expect(deep.speed).toBe(0);
  });

  it('reverses — it is orbital motion, not a net flow', () => {
    const p = at(0, 1500);
    // Sample a full oscillation; the mean must be ~0 or weeds would be permanently pinned.
    let sum = 0;
    const N = 400;
    for (let i = 0; i < N; i++) sum += surgeAt(...p, (i / N) * 7.5, 3).vz;
    expect(Math.abs(sum / N)).toBeLessThan(1e-3);
  });

  it('is a travelling wave, not a global pulse', () => {
    // Two points a half-wavelength apart across the reef line must be out of phase.
    const a = surgeAt(0, chainZ(0) + 1500, 0, 3).vz;
    const b = surgeAt(0, chainZ(0) + 1500 + 17, 0, 3).vz;
    expect(Math.sign(a)).not.toBe(Math.sign(b));
  });
});

describe('currentAt', () => {
  it('is the sum of its parts', () => {
    const [x, z] = at(500, 1500);
    const t = 123, d = 4;
    const total = currentAt(x, z, t, d);
    const a = steadyCurrentAt(x, z, t), b = surgeAt(x, z, t, d);
    expect(total.vx).toBeCloseTo(a.vx + b.vx, 12);
    expect(total.vz).toBeCloseTo(a.vz + b.vz, 12);
    expect(total.speed).toBeCloseTo(Math.hypot(total.vx, total.vz), 12);
  });

  it('is finite and bounded everywhere across the playable box', () => {
    for (let x = -4500; x <= 4500; x += 750) {
      for (let dz = -2500; dz <= 4000; dz += 500) {
        const [wx, wz] = at(x, dz);
        for (const t of [0, 240, 480, 720]) {
          const f = currentAt(wx, wz, t, Math.max(0.5, dz / 50));
          expect(Number.isFinite(f.speed)).toBe(true);
          // Nothing in the world should ever produce an unswimmable wall of water.
          expect(f.speed).toBeLessThan(GULF_MAX_SPEED * 2);
        }
      }
    }
  });
});
