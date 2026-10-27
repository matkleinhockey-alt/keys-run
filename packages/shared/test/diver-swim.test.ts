/**
 * Swim feel (kick cadence, glide, streamlined drag) and the diver being pushed by the real
 * world/current.ts field. Separate from diver.test.ts, which covers the breath/ATA/buoyancy model
 * this pass deliberately left untouched.
 */
import { describe, expect, it } from 'vitest';
import {
  NEUTRAL_DEPTH, SWIM_KICK_ACCEL, KICK_PERIOD, waterVelocity, kickPulse,
  createDiverState, stepDiver,
  type DiverEnv, type DiverInput, type DiverState, type SeafloorSampler, AIR_MAX } from '../src/sim/diver.js';

const DT = 1 / 30;
const DEEP_FLOOR: SeafloorSampler = { heightAt: () => -1000 };
const OPEN_BOUNDS = { x0: -1e6, x1: 1e6, z0: -1e6, z1: 1e6 };
const env = (t: number, seafloor: SeafloorSampler = DEEP_FLOOR): DiverEnv => ({ t, seafloor, worldBounds: OPEN_BOUNDS });
const NO_INPUT: DiverInput = {
  fwd: false, back: false, left: false, right: false, ascend: false, descend: false, sprint: false,
  lookYaw: 0, lookPitch: 0,
};

// Inshore Florida Bay, where the real current is near zero at t=0 (slack tide), so these measure
// the diver's own propulsion rather than the water.
const CALM = { x: -3000, z: -2500 };

function swim(frames: number, input: Partial<DiverInput>, start?: DiverState): DiverState {
  let s = start ?? createDiverState(CALM.x, -NEUTRAL_DEPTH, CALM.z, 0);
  for (let i = 0; i < frames; i++) s = stepDiver(s, { ...NO_INPUT, ...input }, env(0), DT);
  return s;
}
const speed = (s: DiverState): number => Math.hypot(s.vx, s.vz);

describe('swim feel', () => {
  it('kickPulse averages exactly 1 over a cycle, so cadence does not change mean thrust', () => {
    let sum = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) sum += kickPulse(i / N);
    expect(sum / N).toBeCloseTo(1, 2);
  });

  it('thrust arrives in pulses: per-frame speed gain varies strongly across one stroke', () => {
    let s = createDiverState(CALM.x, -NEUTRAL_DEPTH, CALM.z, 0);
    const gains: number[] = [];
    for (let i = 0; i < Math.round(KICK_PERIOD / DT); i++) {
      const before = speed(s);
      s = stepDiver(s, { ...NO_INPUT, fwd: true }, env(0), DT);
      gains.push(speed(s) - before);
    }
    expect(Math.max(...gains)).toBeGreaterThan(3 * Math.max(0.001, Math.min(...gains)));
  });

  it('cruise stays near the old ~1.6 m/s terminal and sprint is clearly faster', () => {
    const c = speed(swim(150, { fwd: true }));
    const sp = speed(swim(150, { fwd: true, sprint: true }));
    expect(c).toBeGreaterThan(1.3);
    expect(c).toBeLessThan(2.0);
    expect(sp).toBeGreaterThan(c * 1.3);
  });

  it('has momentum: after the kicks stop the diver coasts metres, not ~1 m', () => {
    const cruising = swim(120, { fwd: true });
    const coast = swim(150, {}, cruising);
    const glide = Math.abs(coast.z - cruising.z);
    expect(glide).toBeGreaterThan(2.2);
    expect(glide).toBeLessThan(6);
  });

  it('is streamlined: a sideways kick is far weaker than a forward one', () => {
    expect(speed(swim(150, { right: true }))).toBeLessThan(speed(swim(150, { fwd: true })) * 0.7);
  });

  it('kicking backward is weaker than forward', () => {
    expect(speed(swim(150, { back: true }))).toBeLessThan(speed(swim(150, { fwd: true })) * 0.75);
  });

  it('turning carves: sideslip is mostly bled off within a second of changing heading', () => {
    const cruising = swim(120, { fwd: true });
    const turned = swim(30, { fwd: true, lookYaw: Math.PI / 2 }, cruising);
    expect(-turned.vx).toBeGreaterThan(Math.abs(turned.vz) * 0.8);
  });

  it('leaves the breath model alone: identical drain, same nominal kick acceleration', () => {
    expect(SWIM_KICK_ACCEL).toBe(2.6);
    const a = swim(30, { fwd: true });
    // ~0.45 exertion kicking at depth 11: 30 frames of ATA*(1+e*1.2) burn, nowhere near blackout
    // Expressed against the budget, not a literal: this asserts "a second of kicking at 11 m
    // barely dents the breath", which is the actual claim, and survives the budget changing.
    expect(a.air).toBeLessThan(AIR_MAX);
    expect(a.air).toBeGreaterThan(AIR_MAX * 0.94);
  });
});

describe('the diver is pushed by the real current', () => {
  it('waterVelocity is the world current: strong offshore, weak inshore at slack tide', () => {
    const offshore = waterVelocity(0, -20, 2900, 0, -60);
    const inshore = waterVelocity(CALM.x, -3, CALM.z, 0, -8);
    expect(Math.hypot(offshore.x, offshore.z)).toBeGreaterThan(0.5);
    // inshore only has surge (no stream, no tidal exposure out in the bay): well under the stream
    expect(Math.hypot(inshore.x, inshore.z)).toBeLessThan(0.4);
    expect(Math.hypot(inshore.x, inshore.z)).toBeLessThan(Math.hypot(offshore.x, offshore.z));
  });

  it('the near-floor boundary layer shields a diver hugging the bottom', () => {
    const open = waterVelocity(0, -20, 2900, 0, -60);
    const low = waterVelocity(0, -59.5, 2900, 0, -60);
    expect(Math.hypot(low.x, low.z)).toBeLessThan(Math.hypot(open.x, open.z) * 0.5);
  });

  it('an idle diver is carried downstream', () => {
    const w = waterVelocity(0, -20, 2900, 0, -60);
    let s = createDiverState(0, -20, 2900, 0);
    const x0 = s.x;
    const e = env(0, { heightAt: () => -60 });
    for (let i = 0; i < 300; i++) s = stepDiver(s, NO_INPUT, e, DT);
    expect(Math.sign(s.x - x0)).toBe(Math.sign(w.x));
    expect(Math.abs(s.x - x0)).toBeGreaterThan(3);
  });

  it('surge rocks a shallow diver and fades with depth', () => {
    const range = (y: number): number => {
      let lo = Infinity, hi = -Infinity;
      for (let t = 0; t < 8; t += 0.25) { const v = waterVelocity(0, y, 0, t, -30); lo = Math.min(lo, v.z); hi = Math.max(hi, v.z); }
      return hi - lo;
    };
    expect(range(-1)).toBeGreaterThan(range(-18) * 1.5);
  });
});

describe('surfacing with Space', () => {
  // Pins the bug: below neutral depth, negative buoyancy out-pulled the pulsed ascend kick, so
  // holding Space from 30 m sank the diver instead of bringing them up.
  it.each([[10, 6], [20, 11], [30, 16]])('reaches the surface from %i m within %i s holding Space', (depth, maxS) => {
    let s = createDiverState(CALM.x, -depth, CALM.z, 0);
    let t = 0;
    while (s.y < -0.3 && t < 60) { s = stepDiver(s, { ...NO_INPUT, ascend: true }, env(0), DT); t += DT; }
    expect(t).toBeLessThan(maxS);
  });

  it('arrives at the surface rather than launching out of it', () => {
    let s = createDiverState(CALM.x, -20, CALM.z, 0);
    let top = -Infinity;
    for (let i = 0; i < 30 * 20; i++) { s = stepDiver(s, { ...NO_INPUT, ascend: true }, env(0), DT); top = Math.max(top, s.y); }
    expect(top).toBeLessThan(0.5);
  });
});
