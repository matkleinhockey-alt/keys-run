/**
 * The RPM model behind both the engine note and the tachometer.
 *
 * It was extracted from audio/engine.ts so the two cannot drift apart; these pin the behaviour
 * a driver would notice, not the coefficients.
 */
import { describe, it, expect } from 'vitest';
import { rpmTarget, stepRpm, IDLE_RPM, MAX_RPM, REDLINE_RPM } from '../src/sim/tach.js';

const base = { throttle: 0, speedFrac: 0, trimV: 0.2, trimVent: 0, gearRev: 0 };

describe('rpmTarget', () => {
  it('idles at idle and pulls to the top of the band at wide open on the plane', () => {
    expect(rpmTarget(base)).toBeCloseTo(IDLE_RPM, 0);
    const wot = rpmTarget({ ...base, throttle: 1, speedFrac: 1, trimV: 0.5 });
    expect(wot).toBeGreaterThan(REDLINE_RPM);
    expect(wot).toBeLessThanOrEqual(MAX_RPM * 1.12);
  });

  it('rises as the boat comes onto plane at a fixed lever', () => {
    // The prop unloads. This is the thing you hear when a boat stops ploughing and starts
    // running, and the needle has to do it too.
    const stuck = rpmTarget({ ...base, throttle: 0.8, speedFrac: 0 });
    const running = rpmTarget({ ...base, throttle: 0.8, speedFrac: 1 });
    expect(running).toBeGreaterThan(stuck);
  });

  it('is monotonic in throttle', () => {
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const r = rpmTarget({ ...base, throttle: t, speedFrac: 0.4 });
      expect(r).toBeGreaterThan(prev);
      prev = r;
    }
  });

  it('keeps astern down in the bottom quarter of the band however hard you pull', () => {
    // You cannot wind a boat up in reverse, and a tach that swings to redline going astern
    // would be the most obviously wrong thing on the dash.
    for (const t of [-0.2, -0.5, -1]) {
      expect(rpmTarget({ ...base, throttle: t })).toBeLessThan(IDLE_RPM + (MAX_RPM - IDLE_RPM) * 0.75);
    }
  });

  it('flares when the prop ventilates', () => {
    const hooked = rpmTarget({ ...base, throttle: 0.6, speedFrac: 0.6 });
    const blown = rpmTarget({ ...base, throttle: 0.6, speedFrac: 0.6, trimVent: 0.5 });
    expect(blown).toBeGreaterThan(hooked);
  });

  it('never runs away past what the engine could physically turn', () => {
    for (const t of [0, 0.5, 1]) for (const v of [0, 0.5, 1]) for (const g of [0, 1]) {
      const r = rpmTarget({ throttle: t, speedFrac: 1, trimV: 1, trimVent: v, gearRev: g });
      expect(r).toBeLessThanOrEqual(MAX_RPM * 1.12 + 1e-6);
      expect(r).toBeGreaterThanOrEqual(IDLE_RPM - 1e-6);
    }
  });
});

describe('stepRpm', () => {
  it('converges on the target and stays there', () => {
    let r = IDLE_RPM;
    for (let i = 0; i < 400; i++) r = stepRpm(r, 5200, 1 / 60);
    expect(r).toBeCloseTo(5200, 0);
    expect(stepRpm(5200, 5200, 1 / 60)).toBeCloseTo(5200, 6);
  });

  it('comes up faster than it comes down', () => {
    // A big supercharged V8 picks up quickly and takes its time spooling back.
    const up = stepRpm(1000, 6000, 0.1) - 1000;
    const down = 6000 - stepRpm(6000, 1000, 0.1);
    expect(up / 5000).toBeGreaterThan(down / 5000);
  });

  it('never overshoots, at any frame time the game can hand it', () => {
    // dt is clamped at 50 ms upstream, but a step that overshoots would make the needle jitter.
    for (const dt of [1 / 240, 1 / 60, 0.05, 0.2, 1]) {
      expect(stepRpm(700, 6400, dt)).toBeLessThanOrEqual(6400 + 1e-9);
      expect(stepRpm(6400, 700, dt)).toBeGreaterThanOrEqual(700 - 1e-9);
    }
  });
});
