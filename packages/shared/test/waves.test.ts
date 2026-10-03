import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waveHBase, waveSlope, WAVES, SEA_STATES, ampFor, DEFAULT_SW, DEFAULT_CH } from '../src/waves/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
interface WaveSample { x: number; z: number; t: number; amp: number; sw: number; ch: number; waveHBase: number }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const golden: any = JSON.parse(fs.readFileSync(path.join(HERE, 'golden.json'), 'utf8'));

describe('waves: golden fidelity against legacy/index.html', () => {
  it('waveHBase matches legacy\'s wave-sum loop exactly, bit for bit, over 500 (x,z,t) samples', () => {
    for (const s of golden.waves as WaveSample[]) {
      expect(waveHBase(s.x, s.z, s.t, s.amp, s.sw, s.ch)).toBe(s.waveHBase);
    }
  });

  it('waveHBase(x,z,t,amp) with no sea-state args equals the golden default (sw=0.9, ch=1)', () => {
    expect(DEFAULT_SW).toBe(0.9);
    expect(DEFAULT_CH).toBe(1);
    for (const s of (golden.waves as WaveSample[]).slice(0, 50)) {
      expect(waveHBase(s.x, s.z, s.t, s.amp)).toBe(s.waveHBase);
    }
  });
});

describe('waves: data and sanity', () => {
  it('has the 8 legacy wave components', () => {
    expect(WAVES.length).toBe(8);
  });

  it('has the 4 legacy sea states', () => {
    expect(SEA_STATES.map((s) => s.n)).toEqual(['Calm', 'Choppy', 'Haulover', 'Big swell']);
  });

  it('ampFor is small inshore and grows offshore', () => {
    expect(ampFor(1)).toBeLessThan(ampFor(100));
    expect(ampFor(0)).toBeCloseTo(0.1, 10);
  });

  it('waveSlope is finite and roughly matches a numeric gradient of waveHBase', () => {
    const x = 123.4, z = -567.8, t = 42, amp = 1;
    const [sx, sz] = waveSlope(x, z, t, amp);
    expect(Number.isFinite(sx)).toBe(true);
    expect(Number.isFinite(sz)).toBe(true);
    const h = 0.5;
    const dHdx = (waveHBase(x + h, z, t, amp) - waveHBase(x - h, z, t, amp)) / (2 * h);
    const dHdz = (waveHBase(x, z + h, t, amp) - waveHBase(x, z - h, t, amp)) / (2 * h);
    expect(Math.abs(sx - dHdx)).toBeLessThan(0.05);
    expect(Math.abs(sz - dHdz)).toBeLessThan(0.05);
  });
});
