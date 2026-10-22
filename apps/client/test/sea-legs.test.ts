import { describe, expect, it } from 'vitest';
import { createSeaLegsState, stepSeaLegs, trackFootPosition } from '../src/entities/crew-model/sea-legs.js';

const G = 9.81;
const DT = 1 / 60;

function run(seconds: number, f: (t: number) => [number, number, number], accMag = 0) {
  const s = createSeaLegsState();
  for (let t = 0; t < seconds; t += DT) {
    const [fx, fy, fz] = f(t);
    stepSeaLegs(s, fx, fy, fz, accMag, DT);
  }
  return s;
}

describe('sea legs', () => {
  it('stands still on a still, level deck', () => {
    const s = run(5, () => [0, G, 0]);
    expect(Math.abs(s.leanFwd.x)).toBeLessThan(1e-6);
    expect(Math.abs(s.leanSide.x)).toBeLessThan(1e-6);
    expect(s.knee.x).toBeLessThan(1e-6);
  });

  it('stays near world-upright when the deck rolls', () => {
    // Deck rolled 10° so its +x side is down: in the body frame gravity's reaction tilts toward −x.
    const roll = (10 * Math.PI) / 180;
    const s = run(6, () => [-G * Math.sin(roll), G * Math.cos(roll), 0]);
    // Leans back toward −x (uphill) by most of the roll — not carried over with the deck.
    expect(s.leanSide.x).toBeLessThan(-roll * 0.7);
    expect(s.leanSide.x).toBeGreaterThan(-roll);
  });

  it('leans into forward acceleration', () => {
    const s = run(6, () => [0, G, 3]);
    expect(s.leanFwd.x).toBeGreaterThan(0.2);
  });

  it('lags and overshoots a sudden roll, like a body catching its balance', () => {
    const roll = 0.15;
    const s = createSeaLegsState();
    let early = 0, peak = 0;
    for (let i = 0; i < 300; i++) {
      stepSeaLegs(s, -G * Math.sin(roll), G * Math.cos(roll), 0, 0, DT);
      if (i === 6) early = -s.leanSide.x;
      peak = Math.max(peak, -s.leanSide.x);
    }
    expect(early).toBeLessThan(s.targetSide * -0.3); // ~0.1 s in, still well behind
    expect(peak).toBeGreaterThan(-s.targetSide); // overshoots before settling
  });

  it('bends the knees under heave load and extends them when the deck drops away', () => {
    const heavy = run(3, () => [0, G * 1.4, 0]);
    const light = run(3, () => [0, G * 0.6, 0]);
    expect(heavy.knee.x).toBeGreaterThan(0.12);
    expect(light.knee.x).toBeLessThan(0.02);
  });

  it('keeps softer knees in a rough sea', () => {
    const calm = run(6, () => [0, G, 0], 0);
    const rough = run(6, () => [0, G, 0], 5);
    expect(rough.knee.x).toBeGreaterThan(calm.knee.x + 0.1);
  });

  it('goes slack in free fall rather than leaning at a meaningless apparent vertical', () => {
    const s = run(2, () => [0.5, 0.2, 0.8]);
    expect(Math.abs(s.leanFwd.x)).toBeLessThan(0.01);
    expect(Math.abs(s.leanSide.x)).toBeLessThan(0.01);
    expect(s.knee.x).toBe(0);
  });

  it('recovers acceleration from a heaving foot position', () => {
    const s = createSeaLegsState();
    const A = 0.8, w = 2 * Math.PI * 0.25; // 0.8 m swell, 4 s period
    let maxAy = 0;
    for (let t = 0; t < 12; t += DT) {
      trackFootPosition(s, 0, A * Math.sin(w * t), 0, DT);
      if (t > 4) maxAy = Math.max(maxAy, Math.abs(s.ay));
    }
    // True peak is A·ω² ≈ 1.97 m/s²; the low-passes shave a little off.
    expect(maxAy).toBeGreaterThan(1.6);
    expect(maxAy).toBeLessThan(2.2);
  });

  it('ignores a teleport instead of reading it as an enormous acceleration', () => {
    const s = createSeaLegsState();
    for (let i = 0; i < 10; i++) trackFootPosition(s, 0, 0, 0, DT);
    expect(trackFootPosition(s, 500, 0, 0, DT)).toBe(false);
    expect(s.ax).toBe(0);
  });
});
