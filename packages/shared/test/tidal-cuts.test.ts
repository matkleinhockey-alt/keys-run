/**
 * The tide through the cuts.
 *
 * Before this the flow field had three components that all ran along the SAME axis — the chain
 * tangent — so wherever you went the current pointed up or down the Keys and only its strength
 * changed. The cuts are the part that makes the field actually vary in DIRECTION, and they are
 * the thing anyone running these waters plans around.
 */
import { describe, expect, it } from 'vitest';
import {
  TIDAL_CUTS, CUT_MAX_SPEED, cutJetAt, steadyCurrentAt, chainNormal, chainTangent,
  TIDE_PERIOD_S, GULF_MAX_SPEED,
} from '../src/world/current.js';
import { chainZ } from '../src/world/chain.js';

const FLOOD = TIDE_PERIOD_S / 4;
const EBB = (TIDE_PERIOD_S * 3) / 4;
const onChain = (x: number): number => chainZ(x);
const narrowest = (): typeof TIDAL_CUTS[number] => TIDAL_CUTS.reduce((a, b) => (a.width < b.width ? a : b));

describe('the cuts themselves', () => {
  it('finds the real gaps in the chain', () => {
    expect(TIDAL_CUTS.length).toBeGreaterThanOrEqual(4);
    for (const c of TIDAL_CUTS) {
      expect(c.width).toBeGreaterThan(0);
      expect(c.speed).toBeGreaterThan(0);
      expect(c.speed).toBeLessThanOrEqual(CUT_MAX_SPEED);
    }
    // Vaca Cut is the tightest gap in this chain, and so the fastest water in it.
    const n = narrowest();
    for (const c of TIDAL_CUTS) if (c !== n) expect(n.speed).toBeGreaterThanOrEqual(c.speed);
  });

  it('runs a narrow throat faster than a wide span, which is just continuity', () => {
    const sorted = [...TIDAL_CUTS].sort((a, b) => a.width - b.width);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].speed, `${sorted[i].width}m vs ${sorted[i - 1].width}m`)
        .toBeLessThanOrEqual(sorted[i - 1].speed + 1e-9);
    }
  });
});

describe('the jet', () => {
  it('runs ACROSS the chain, not along it — the whole point', () => {
    for (const c of TIDAL_CUTS.filter((q) => q.width < 150)) {
      const f = cutJetAt(c.x, onChain(c.x), FLOOD);
      const n = chainNormal(c.x), t = chainTangent(c.x);
      const across = Math.abs(f.vx * n.nx + f.vz * n.nz);
      const along = Math.abs(f.vx * t.tx + f.vz * t.tz);
      expect(across, `cut at ${c.x}`).toBeGreaterThan(along * 5);
    }
  });

  it('is slack at slack water and reverses between flood and ebb', () => {
    const c = narrowest();
    const z = onChain(c.x);
    expect(cutJetAt(c.x, z, 0).speed).toBeCloseTo(0, 9);
    const fl = cutJetAt(c.x, z, FLOOD), eb = cutJetAt(c.x, z, EBB);
    expect(fl.speed).toBeGreaterThan(0.5);
    expect(eb.speed).toBeCloseTo(fl.speed, 6);
    expect(Math.sign(eb.vz)).toBe(-Math.sign(fl.vz));   // opposite ways through the same hole
  });

  it('is a jet, not a region: it dies within a couple of gap-widths', () => {
    const c = narrowest();
    const at = (d: number): number => cutJetAt(c.x + d, onChain(c.x + d), FLOOD).speed;
    expect(at(0)).toBeGreaterThan(at(c.width));
    expect(at(c.width * 4)).toBeLessThan(at(0) * 0.15);
  });

  it('leaves water nowhere near a cut alone', () => {
    // Mid-Vaca, far from any gap: whatever is happening there is the stream and the tide, as
    // before, so this is also the regression guard on the original field.
    const far = Math.min(...TIDAL_CUTS.map((c) => Math.abs(0 - c.x)));
    expect(far, 'x=0 should be well clear of every cut').toBeGreaterThan(1000);
    expect(cutJetAt(0, onChain(0), FLOOD).speed).toBeCloseTo(0, 6);
  });
});

describe('the field stays sane', () => {
  it('is finite and bounded everywhere, at every state of tide', () => {
    const cap = GULF_MAX_SPEED + CUT_MAX_SPEED + 1;
    for (let x = -4500; x <= 4500; x += 125) {
      for (const dz of [-900, -300, 0, 300, 900, 2600]) {
        for (const t of [0, FLOOD, TIDE_PERIOD_S / 2, EBB]) {
          const f = steadyCurrentAt(x, chainZ(x) + dz, t);
          expect(Number.isFinite(f.speed), `x${x} dz${dz} t${t}`).toBe(true);
          expect(f.speed, `x${x} dz${dz} t${t}`).toBeLessThan(cap);
          expect(f.speed).toBeCloseTo(Math.hypot(f.vx, f.vz), 9);
        }
      }
    }
  });
});
