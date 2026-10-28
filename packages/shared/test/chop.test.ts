/**
 * Short wind chop (waves/index.ts's CHOP).
 *
 * The legacy field has nothing below 40 m of wavelength, so the sea had no energy at the scale a
 * boat moves on. These pin the physics the chop has to obey and the behaviour it was added for,
 * not the coefficients.
 */
import { describe, it, expect } from 'vitest';
import { CHOP, WAVES, chopAmpFor, waveHBase, waveSlope, SEA_STATES } from '../src/waves/index.js';
import { ampAt, chopAt, seaHAt } from '../src/sim/depth-grid.js';
import { chainZ } from '../src/world/chain.js';

const G = 9.81;

describe('the chop components', () => {
  it('are real deep-water waves', () => {
    // w^2 = gk. Every one of the eight legacy components satisfies this to better than 1.3%, and
    // chop that did not would travel at a speed no wave of its length travels at — visible as
    // crests sliding through each other at the wrong rate.
    for (const W of CHOP) {
      const k = Math.hypot(W[0], W[1]);
      expect(W[2] * W[2] / k, `component k=${k.toFixed(3)}`).toBeCloseTo(G, 1);
    }
  });

  it('are short — that is the entire point — but not shorter than the water mesh can draw', () => {
    for (const W of CHOP) {
      const lambda = 2 * Math.PI / Math.hypot(W[0], W[1]);
      // Shorter than every legacy component (the shortest of those is 40 m)...
      expect(lambda).toBeLessThan(25);
      // ...and no shorter than ~10 m: the water plane carries ~1.9 m between vertices at the
      // camera (2.8 m on touch), so anything finer is under four vertices and reads as facets.
      expect(lambda).toBeGreaterThan(10);
    }
    const shortestLegacy = Math.min(...WAVES.map((W) => 2 * Math.PI / Math.hypot(W[0], W[1])));
    expect(shortestLegacy).toBeGreaterThan(35);
  });

  it('are more sharply crested than the swell, as short steep waves are', () => {
    const swellPeak = Math.max(...WAVES.filter((W) => W[6] === 1).map((W) => W[4]));
    for (const W of CHOP) expect(W[4]).toBeGreaterThan(swellPeak);
  });
});

describe('the chop envelope', () => {
  it('survives inshore, where the swell envelope has nothing left', () => {
    // Wind chop is made locally on whatever water is there. A foot of water on a flat still gets
    // chop; it is just depth-limited.
    expect(chopAmpFor(1)).toBeGreaterThan(0.2);
    expect(chopAmpFor(0.3)).toBeGreaterThan(0.1);
  });

  it('is damped shallow and saturates once the bottom stops mattering', () => {
    expect(chopAmpFor(0.5)).toBeLessThan(chopAmpFor(3));
    expect(chopAmpFor(3)).toBeLessThan(chopAmpFor(6));
    expect(chopAmpFor(6)).toBeCloseTo(chopAmpFor(600), 6);
  });

  it('does not inherit the surf break boost, which belongs to the swell', () => {
    // inletAt runs to INLET_MAX (4) over the bar — that is swell feeling the bottom and standing
    // up. Multiplying short wind chop by four there would stack a metre of it on the break on a
    // flat calm day.
    for (let x = -3200; x <= 3200; x += 40) {
      for (let dz = -1000; dz <= 1600; dz += 40) {
        const z = chainZ(x) + dz;
        const c = chopAt(x, z);
        expect(c, `chopAt(${x}, ${z.toFixed(0)})`).toBeLessThanOrEqual(1.6 + 1e-9);
      }
    }
  });
});

describe('what the chop is for', () => {
  const X = 0, Z = chainZ(0) + 900;           // the Hawk Channel, where the game is played
  const amp = ampAt(X, Z), cAmp = chopAt(X, Z);

  const steepest = (sw: number, ch: number, chop: number): number => {
    let m = 0;
    for (let t = 0; t < 90; t += 0.05) {
      const [sx, sz] = waveSlope(X, Z, t, amp, sw, ch, chop);
      m = Math.max(m, Math.hypot(sx, sz));
    }
    return Math.atan(m) * 180 / Math.PI;
  };

  it('makes Haulover actually steep', () => {
    // Its own description is "steep, stacked inlet chop. Trim up and hang on." Without chop the
    // steepest the surface ever got here was 1.8 degrees.
    const H = SEA_STATES.find((s) => s.n === 'Haulover')!;
    expect(steepest(H.sw, H.ch, 0)).toBeLessThan(3);
    expect(steepest(H.sw, H.ch, cAmp)).toBeGreaterThan(8);
  });

  it('makes Haulover steeper than Big swell, which is big but long', () => {
    const H = SEA_STATES.find((s) => s.n === 'Haulover')!;
    const B = SEA_STATES.find((s) => s.n === 'Big swell')!;
    // Without chop the two are indistinguishable in steepness and Big swell is actually steeper,
    // which is backwards: a long roller is not steep, that is what makes it a roller.
    expect(steepest(H.sw, H.ch, cAmp)).toBeGreaterThan(steepest(B.sw, B.ch, cAmp));
  });

  it('separates the sea states by steepness, in order', () => {
    const order = ['Calm', 'Choppy', 'Haulover'].map((n) => {
      const S = SEA_STATES.find((s) => s.n === n)!;
      return steepest(S.sw, S.ch, cAmp);
    });
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  it('gives a hull something to pitch on', () => {
    // Bow and stern of a 9.3 m Grady. This is the number that decides whether the boat looks like
    // it is on water or on glass; it was 1.4 degrees at Haulover before.
    const H = SEA_STATES.find((s) => s.n === 'Haulover')!;
    let maxPitch = 0;
    for (let t = 0; t < 90; t += 0.05) {
      const a = waveHBase(X - 4.65, Z, t, amp, H.sw, H.ch, cAmp);
      const b = waveHBase(X + 4.65, Z, t, amp, H.sw, H.ch, cAmp);
      maxPitch = Math.max(maxPitch, Math.atan2(Math.abs(a - b), 9.3) * 180 / Math.PI);
    }
    expect(maxPitch).toBeGreaterThan(4);
    // ...and not so much that a centre console is standing on end.
    expect(maxPitch).toBeLessThan(20);
  });
});

describe('seaHAt', () => {
  it('is the swell plus the chop, each on its own envelope', () => {
    for (const [x, dz] of [[0, 900], [-1500, -700], [2000, 1400]] as const) {
      const z = chainZ(x) + dz, t = 31.7;
      expect(seaHAt(x, z, t)).toBeCloseTo(waveHBase(x, z, t, ampAt(x, z), undefined, undefined, chopAt(x, z)), 12);
    }
  });

  it('still has a gradient that matches a numeric one, with chop in', () => {
    // waveSlope grew a chop term of its own; if it disagreed with waveHBase the hull would be
    // surged by a slope the surface does not have.
    const x = 123.4, z = chainZ(123.4) + 820, t = 42, amp = ampAt(x, z), c = chopAt(x, z);
    const [sx, sz] = waveSlope(x, z, t, amp, 1.3, 1.2, c);
    const h = 0.25;
    const dx = (waveHBase(x + h, z, t, amp, 1.3, 1.2, c) - waveHBase(x - h, z, t, amp, 1.3, 1.2, c)) / (2 * h);
    const dz2 = (waveHBase(x, z + h, t, amp, 1.3, 1.2, c) - waveHBase(x, z - h, t, amp, 1.3, 1.2, c)) / (2 * h);
    expect(Math.abs(sx - dx)).toBeLessThan(0.02);
    expect(Math.abs(sz - dz2)).toBeLessThan(0.02);
  });
});
