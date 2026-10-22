/**
 * Reel physics (sim/reels.ts): lands exactly where the draw said, stops one after another, eases
 * out smoothly with a small overshoot, and is the same at any frame rate.
 */
import { describe, expect, it } from 'vitest';
import {
  CRUISE, FIRST_STOP_S, OVERSHOOT, SETTLE_S, SPIN_UP_S, STAGGER_S, TEASE_EXTRA_S, createReels, phaseAt, planReel, positionAt, topIndex, viewOf, windup,
} from '../src/sim/reels.js';
import { REEL_LEN, drawStops, teaseReel, gridFor } from '../src/sim/slots.js';

/** Step a spin at a fixed dt (the harness convention is 0.05 s per rendered frame at most). */
function run(from: number[], stops: number[], tease: number | null, dt: number) {
  const r = createReels(from, stops, tease);
  const trace: Array<{ t: number; y: number[] }> = [];
  const events: Array<{ reel: number; kind: string; t: number }> = [];
  let guard = 0;
  while (!r.done && guard++ < 5000) {
    r.step(dt);
    trace.push({ t: r.t, y: [0, 1, 2].map((i) => r.y(i)) });
    events.push(...r.drain());
  }
  return { r, trace, events };
}

describe('reel physics', () => {
  it('lands every reel exactly on the stop it was given, from any resting position, at any dt', () => {
    for (let n = 0; n < 150; n++) {
      const from = drawStops(11, n + 500), stops = drawStops(11, n);
      for (const dt of [0.05, 1 / 60, 0.2]) {
        const { r } = run(from, stops, null, dt);
        for (let i = 0; i < 3; i++) {
          const v = r.view(i);
          expect(v.frac, `spin ${n} reel ${i} dt ${dt}`).toBeLessThan(1e-9);
          expect(v.base % REEL_LEN, `spin ${n} reel ${i}`).toBe(stops[i]);
        }
      }
    }
  });

  it('is the same at any frame rate: position is a function of time, not of the number of steps', () => {
    const a = createReels([3, 9, 20], [14, 2, 7], null), b = createReels([3, 9, 20], [14, 2, 7], null);
    for (let i = 0; i < 40; i++) a.step(0.05);
    for (let i = 0; i < 120; i++) b.step(1 / 60);
    expect(a.t).toBeCloseTo(b.t, 9);
    for (let i = 0; i < 3; i++) expect(a.y(i)).toBeCloseTo(b.y(i), 9);
  });

  it('stops one after another, left to right, STAGGER_S apart, and the thunks arrive in that order', () => {
    const { r, events } = run([0, 0, 0], [5, 6, 7], null, 0.05);
    const stops = r.plans.map((p) => p.stopAt);
    expect(stops[0]).toBeCloseTo(FIRST_STOP_S, 9);
    expect(stops[1] - stops[0]).toBeCloseTo(STAGGER_S, 9);
    expect(stops[2] - stops[1]).toBeCloseTo(STAGGER_S, 9);
    const thunks = events.filter((e) => e.kind === 'thunk');
    expect(thunks.map((e) => e.reel)).toEqual([0, 1, 2]);
    expect(thunks[0].t).toBeLessThan(thunks[1].t);
    expect(thunks[1].t).toBeLessThan(thunks[2].t);
    const rests = events.filter((e) => e.kind === 'rest');
    expect(rests.map((e) => e.reel)).toEqual([0, 1, 2]);
    for (let i = 0; i < 3; i++) expect(rests[i].t).toBeGreaterThan(thunks[i].t);
  });

  it('a whole spin takes about three simulated seconds, whatever was drawn, so the 3.2 s spin gap is the reel time and not an arbitrary wait', () => {
    const { r } = run([0, 0, 0], [5, 6, 7], null, 0.05);
    expect(r.duration).toBeGreaterThan(2.8);
    expect(r.duration).toBeLessThan(3.4);
  });

  it('eases out: speed falls monotonically through the stop and there is no jump where the stop begins', () => {
    for (let s = 0; s < REEL_LEN; s += 3) {
      const p = planReel(4, s, FIRST_STOP_S, false);
      let prevV = Infinity;
      const h = 1e-3;
      for (let t = p.stopAt - 0.2; t < p.stopAt + p.decelS - 0.01; t += 0.01) {
        const v = (positionAt(p, t + h) - positionAt(p, t - h)) / (2 * h);
        expect(v, `s=${s} t=${t.toFixed(2)}`).toBeLessThanOrEqual(prevV + 1e-6);
        prevV = v;
      }
      // continuity at the start of the stop: speed just before and just after agree (both ~CRUISE)
      const before = (positionAt(p, p.stopAt - 1e-4) - positionAt(p, p.stopAt - 2e-4)) / 1e-4;
      const after = (positionAt(p, p.stopAt + 2e-4) - positionAt(p, p.stopAt + 1e-4)) / 1e-4;
      expect(Math.abs(before - after)).toBeLessThan(CRUISE * 0.01);
      expect(before).toBeCloseTo(CRUISE, 0);
    }
  });

  it('overshoots the line by a fraction of a symbol and settles back, never going backwards during the run', () => {
    const p = planReel(0, 9, FIRST_STOP_S, false);
    let max = -Infinity, prev = -Infinity;
    for (let t = SPIN_UP_S; t < p.stopAt + p.decelS; t += 0.005) {
      const y = positionAt(p, t);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y; max = Math.max(max, y);
    }
    expect(max).toBeCloseTo(p.yTarget + OVERSHOOT, 6);
    // the settle pulls back by exactly the overshoot
    expect(positionAt(p, p.stopAt + p.decelS + SETTLE_S * 0.5)).toBeLessThan(p.yTarget + OVERSHOOT);
    expect(positionAt(p, p.doneAt + 1)).toBe(p.yTarget);
    expect(phaseAt(p, 0.05)).toBe('windup');
    expect(phaseAt(p, 0.6)).toBe('spinning');
    expect(phaseAt(p, p.stopAt + 0.1)).toBe('stopping');
    expect(phaseAt(p, p.stopAt + p.decelS + 0.05)).toBe('settling');
    expect(phaseAt(p, p.doneAt + 0.01)).toBe('stopped');
  });

  it('winds up backwards a little before it goes, and only then', () => {
    expect(windup(0)).toBe(0);
    expect(windup(0.08)).toBeLessThan(-0.1);
    expect(windup(0.5)).toBe(0);
  });

  it('holds a teased reel longer and brakes it over a longer run, without changing where it lands', () => {
    const calm = run([0, 0, 0], [3, 3, 3], null, 0.05), tease = run([0, 0, 0], [3, 3, 3], 2, 0.05);
    expect(tease.r.plans[2].stopAt - calm.r.plans[2].stopAt).toBeCloseTo(TEASE_EXTRA_S, 9);
    expect(tease.r.plans[2].decelS).toBeGreaterThan(calm.r.plans[2].decelS);
    expect(tease.r.duration).toBeGreaterThan(calm.r.duration + TEASE_EXTRA_S);
    expect(tease.r.view(2).base).toBe(3);
    expect(tease.r.plans[0].stopAt).toBe(calm.r.plans[0].stopAt);
  });

  it('only teases a result that already had two big fish lined up, and never alters the stops', () => {
    let teased = 0, total = 3000;
    for (let n = 0; n < total; n++) {
      const stops = drawStops(99, n);
      const t = teaseReel(gridFor(stops));
      if (t !== null) teased++;
      const reels = createReels([0, 0, 0], stops, t);
      for (let i = 0; i < 3; i++) expect(reels.plans[i].stopIndex).toBe(stops[i]);
    }
    // a tease is a rare event, not decoration on every spin
    expect(teased).toBeGreaterThan(0);
    expect(teased / total).toBeLessThan(0.1);
  });

  it('slams: a second press stops the remaining reels now, in order, still landing exactly', () => {
    const r = createReels([2, 4, 6], [11, 12, 13], null);
    for (let i = 0; i < 8; i++) r.step(0.05); // 0.4 s in, nothing has begun to stop
    const before = r.duration;
    r.slam();
    expect(r.duration).toBeLessThan(before - 0.5);
    const order: number[] = [];
    let guard = 0;
    while (!r.done && guard++ < 400) { r.step(0.05); order.push(...r.drain().filter((e) => e.kind === 'thunk').map((e) => e.reel)); }
    expect(order).toEqual([0, 1, 2]);
    for (let i = 0; i < 3; i++) expect(r.view(i).base).toBe([11, 12, 13][i]);
  });

  it('draws the symbols moving DOWN the window as the reel spins (top index falls as travel grows) and wraps', () => {
    const p = planReel(10, 3, FIRST_STOP_S, false);
    expect(topIndex(p, 0)).toBe(10);
    expect(topIndex(p, 0.5)).toBeCloseTo(9.5, 9);
    expect(topIndex(p, 1)).toBe(9);
    expect(topIndex(planReel(0, 3, FIRST_STOP_S, false), 1)).toBe(REEL_LEN - 1);
    expect(viewOf(p, positionAt(p, 9))).toMatchObject({ base: 3, frac: 0 });
  });

  it('takes the same time whatever was drawn: the schedule never depends on the stop', () => {
    const d = new Set<number>();
    for (let n = 0; n < 200; n++) d.add(+createReels(drawStops(3, n + 900), drawStops(3, n), null).duration.toFixed(9));
    expect(d.size).toBe(1);
  });

  it('never re-maps the picture while a reel is slow enough to see it happen', () => {
    for (let n = 0; n < 50; n++) {
      const p = planReel(drawStops(8, n)[0], drawStops(8, n + 77)[1], FIRST_STOP_S, false);
      // the switch happens in cruise: every moment the re-map could occur the reel is at full speed
      expect(positionAt(p, p.stopAt) - p.ySwitch).toBeLessThanOrEqual(2 + 1e-9);
      expect(p.ySwitch).toBeGreaterThanOrEqual(positionAt(p, SPIN_UP_S) - 1e-9);
    }
  });
});
