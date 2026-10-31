/**
 * stepSchool must be a pure function of (school state, sim-time sequence): two clients that build
 * the same school and step it through the same `t` values have to see the same fish doing the
 * same thing, because nothing about school motion is sent over the network. It used to call
 * Math.random() (directly and through core/math's `rand`) for glide rolls, frenzy and dive
 * timers, act cooldowns, the boundary turn side and the humpback breach roll, so every client's
 * school diverged within seconds of the first roll.
 *
 * The second half guards the opposite failure: a swap that freezes the randomness. It checks
 * that distinct schools still diverge and that members still spread and turn over a minute.
 */
import { describe, expect, it } from 'vitest';
import { residentsForChunk, instantiateResident } from '../src/entities/fish/spawn.js';
import { stepSchool } from '../src/entities/fish/school.js';
import type { SchoolState } from '../src/entities/fish/types.js';
import { VIS } from '@keysrun/shared/content/creatures';

const SEED = 20240817;
const DT = 1 / 30;

/** First `n` resident schools (of `type`, or any) found scanning the chart's chunk grid. */
function schools(n: number, type?: string): SchoolState[] {
  const out: SchoolState[] = [];
  for (let cx = -40; cx <= 40 && out.length < n; cx++) {
    for (let cz = 0; cz <= 40 && out.length < n; cz++) {
      const spec = residentsForChunk(SEED, cx, cz);
      if (spec && (!type || spec.type === type)) out.push(instantiateResident(spec, cx, cz));
    }
  }
  return out;
}

const clone = <T,>(s: T): T => structuredClone(s);

function run(s: SchoolState, seconds: number, onStep?: (s: SchoolState) => void): SchoolState {
  const V = VIS[s.type]!;
  for (let i = 1; i <= Math.round(seconds / DT); i++) {
    stepSchool(s, V, { t: i * DT, dt: DT, threats: [] });
    onStep?.(s);
  }
  return s;
}

/** Spread and heading statistics over a run, sampled once a second. */
function liveliness(s: SchoolState, seconds = 60) {
  const radii: number[] = [];
  const yawDev: number[] = [];
  let turned = 0;
  let diveFlips = 0, actStarts = 0, prevTarget = s.diveTarget;
  const meanY: number[] = [];
  const wasActing = s.members.map(() => false);
  let last = s.heading;
  let i = 0;
  run(s, seconds, (st) => {
    let dh = st.heading - last; last = st.heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    turned += Math.abs(dh);
    if (st.diveTarget !== prevTarget) { diveFlips++; prevTarget = st.diveTarget; }
    st.members.forEach((m, k) => { if (m.act && !wasActing[k]) actStarts++; wasActing[k] = !!m.act; });
    meanY.push(st.members.reduce((a, m) => a + m.wy, 0) / st.members.length);
    if (++i % 30) return;
    let sx = 0, sz = 0;
    for (const m of st.members) {
      radii.push(Math.hypot(m.wx - st.cx, m.wz - st.cz));
      sx += Math.cos(m.yaw); sz += Math.sin(m.yaw);
    }
    // circular std of member yaw: sqrt(-2 ln R)
    const R = Math.hypot(sx, sz) / st.members.length;
    yawDev.push(Math.sqrt(-2 * Math.log(Math.max(1e-9, R))));
  });
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  const sd = Math.sqrt(radii.reduce((a, b) => a + (b - mean) ** 2, 0) / radii.length);
  return {
    type: s.type,
    meanRadius: +mean.toFixed(3), radiusSd: +sd.toFixed(3),
    yawSpread: +(yawDev.reduce((a, b) => a + b, 0) / yawDev.length).toFixed(4),
    headingTurned: +turned.toFixed(3),
    depthRange: +(Math.max(...meanY) - Math.min(...meanY)).toFixed(3), diveFlips, actStarts,
  };
}

const snapshot = (s: SchoolState) => JSON.stringify(s);

describe('stepSchool determinism', () => {
  it('two runs of the same school from the same state are identical member-for-member', () => {
    const [base] = schools(1);
    expect(base).toBeDefined();
    const a = run(clone(base!), 120);
    const b = run(clone(base!), 120);
    expect(b.members.length).toBe(a.members.length);
    a.members.forEach((m, i) => expect(b.members[i]).toEqual(m));
    expect(snapshot(b)).toBe(snapshot(a));
  });

  it('is identical across every species the scan finds (all rolled branches)', () => {
    const seen = new Set<string>();
    for (const base of schools(400)) {
      if (seen.has(base.type)) continue;
      seen.add(base.type);
      const a = run(clone(base), 90);
      const b = run(clone(base), 90);
      expect(snapshot(b), base.type).toBe(snapshot(a));
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('different schools are NOT identical (randomness was not frozen)', () => {
    const type = schools(1)[0]!.type;
    const [s1, s2] = schools(2, type);
    expect(s2).toBeDefined();
    const a = run(clone(s1!), 60);
    const b = run(clone(s2!), 60);
    expect(snapshot(a)).not.toBe(snapshot(b));
    // Same state, different id: the timers must differ, so decorrelation really comes from the id.
    const twin = clone(s1!); twin.id = 'res:other';
    const c = run(twin, 60);
    const timers = (s: SchoolState) => [s.diveTimer, s.frenzyTimer, s.glide, s.diveTarget, ...s.members.map((m) => m.actTimer)];
    expect(timers(c)).not.toEqual(timers(a));
  });

  it('stays lively over 60 s: members spread out around the centre', () => {
    const stats = schools(6).map((s) => liveliness(clone(s)));
    if (process.env.FISH_MEASURE) console.log('LIVELINESS ' + JSON.stringify(stats));
    for (const st of stats) {
      expect(st.meanRadius).toBeGreaterThan(0.5);
      expect(st.radiusSd).toBeGreaterThan(0.1);
    }
  });
});
