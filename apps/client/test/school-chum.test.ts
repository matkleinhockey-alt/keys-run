/**
 * A dead bird floating on the surface must actually pull the right schools to it, through
 * `stepSchool` and nothing else.
 *
 * `packages/shared/test/chum.test.ts` pins the rules in isolation (who, how far, how long). This
 * file pins the thing the rules exist for: that a school stepped by the real simulation ends up
 * closer to the carcass than it would have otherwise, and that the wrong species does not.
 *
 * Why "than it would have otherwise" and not just "closer than it started": a school with no
 * anchor wanders, and over a couple of simulated minutes it will sometimes drift toward a point by
 * chance. So every case runs the SAME school twice from the same seedless initial state — once
 * with a carcass in the water and once without — and compares. The control run is the measurement;
 * a single run would only ever be an anecdote.
 */
import { describe, expect, it } from 'vitest';
import { stepSchool } from '../src/entities/fish/school.js';
import type { SchoolState } from '../src/entities/fish/types.js';
import { VIS } from '@keysrun/shared/content/creatures';
import { CARCASS_LIFE_S, createCarcass, stepCarcasses, type Carcass } from '@keysrun/shared/sim/chum';

const DT = 1 / 30;
/** Open water off the reef line, deep enough for a shark and a snapper both (see school-anchor). */
const CX = 300, CZ = 900;

/**
 * A roaming school — `anchor: null`, exactly as `spawn.ts`'s roaming layer builds one. This is the
 * case that matters: nearly every species a carcass attracts is a roamer, so a lean that only
 * worked on anchored residents would work on almost nothing.
 */
function roamer(type: string, x: number, z: number, heading: number): SchoolState {
  const V = VIS[type];
  const members: SchoolState['members'] = Array.from({ length: Math.max(3, V.school[0]) }, (_, i) => ({
    ox: (i % 3) - 1, oz: Math.floor(i / 3) - 1, oy: 0, swimPhase: i * 0.7, seed: i * 0.7, bank: 0, scale: 1, sizeU: 0.5,
    act: null, actPhase: 0, actTimer: 2 + i, splashed: false, splashed2: false, breaching: false,
    wx: x, wy: -4, wz: z, yaw: heading, pitch: 0, roll: 0, worldScale: 1,
  }));
  return {
    id: `c:${type}:${heading.toFixed(2)}`, type, cx: x, cz: z, heading, phase: heading * 17.3,
    vx: 0, vz: 0, turnRate: 0, turn: 0, flee: 0, fleeHeading: heading, bowRide: 0, glide: 0, frenzy: 0, frenzyTimer: 0, dive: 0,
    diveTimer: 9, diveTarget: 0, anchor: null, resident: false, members,
  };
}

/** Steps `g` for `secs`, with `carcasses` aged by the same clock. Returns the closest approach to
 * (CX,CZ) and where it ended up — closest approach matters because a school milling over a
 * carcass is sometimes on the far side of the ring when the clock stops. */
function run(g: SchoolState, carcasses: Carcass[], secs: number): { end: number; min: number } {
  const V = VIS[g.type];
  let t = 0, live = carcasses, min = Math.hypot(g.cx - CX, g.cz - CZ);
  for (let i = 0; i < Math.round(secs / DT); i++) {
    t += DT;
    live = stepCarcasses(live, undefined, DT);
    stepSchool(g, V, { t, dt: DT, threats: [], carcasses: live });
    const d = Math.hypot(g.cx - CX, g.cz - CZ);
    if (d < min) min = d;
  }
  return { end: Math.hypot(g.cx - CX, g.cz - CZ), min };
}

/** The same school run with and without a fresh carcass at (CX,CZ). Several headings, because one
 * starting angle tells you nothing: a wandering school's drift is dominated by where it was
 * pointed. */
function compare(type: string, startD: number, secs: number): { withC: number[]; without: number[] } {
  const headings = [0, 0.9, 1.8, 2.7, 3.6, 4.5, 5.4];
  const withC: number[] = [], without: number[] = [];
  for (const h of headings) {
    withC.push(run(roamer(type, CX - startD, CZ, h), [createCarcass('c', CX, CZ)], secs).min);
    without.push(run(roamer(type, CX - startD, CZ, h), [], secs).min);
  }
  return { withC, without };
}

const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length;

describe('a carcass draws the big predatory species in', () => {
  it('a bullshark 40 m off closes on it, and would not have otherwise', () => {
    const { withC, without } = compare('bullshark', 40, 90);
    // Measured: mean closest approach 1.2 m with the carcass in the water, 26.1 m without it.
    expect(mean(withC), `with=${mean(withC).toFixed(1)} without=${mean(without).toFixed(1)}`).toBeLessThan(mean(without) * 0.5);
    // And it is not one lucky heading carrying the average: every start must get there.
    for (let i = 0; i < withC.length; i++) {
      expect(withC[i], `heading ${i} only got within ${withC[i].toFixed(1)} m`).toBeLessThan(15);
    }
  });

  it('works for a shark, a barracuda and a jack alike', () => {
    for (const type of ['tigershark', 'barracuda', 'jackcrevalle', 'cobia', 'tarpon']) {
      const { withC, without } = compare(type, 35, 90);
      expect(mean(withC), `${type}: with=${mean(withC).toFixed(1)} without=${mean(without).toFixed(1)}`)
        .toBeLessThan(mean(without) * 0.6);
    }
  });

  it('having arrived, it stays and mills over the carcass rather than passing through', () => {
    // 40 m out, then 100 s to arrive and 60 s more to hang around. The test is where it IS at the
    // end, not its closest approach: a school that merely flew past would be long gone.
    const g = roamer('bullshark', CX - 40, CZ, 1.2);
    const { end } = run(g, [createCarcass('c', CX, CZ)], 160);
    expect(end, `ended ${end.toFixed(1)} m from the carcass`).toBeLessThan(20);
  });

  it('leaves once the carcass is gone', () => {
    // Bring it in, let the carcass expire, then keep running with empty water. It must wander off
    // rather than keep orbiting a point that no longer has anything at it.
    const g = roamer('bullshark', CX - 25, CZ, 1.2);
    run(g, [createCarcass('c', CX, CZ)], 80);
    const arrived = Math.hypot(g.cx - CX, g.cz - CZ);
    expect(arrived, `never arrived (${arrived.toFixed(1)} m)`).toBeLessThan(20);
    // One spent carcass in the list, plus plenty of clock: `chumPull` returns null for it, so the
    // synthesized patch disappears and the roamer is a roamer again.
    const spent = [{ ...createCarcass('c', CX, CZ), age: CARCASS_LIFE_S + 1 }];
    const after = run(g, spent, 180);
    // Measured: 35.9 m out after 120 s, and past 40 m by 180 — which is why the window is 180 and
    // not 120. It leaves at its own pace rather than bolting, which is right: nothing frightened
    // it, the food simply ran out.
    expect(after.end, `still sitting ${after.end.toFixed(1)} m off a carcass that is gone`).toBeGreaterThan(40);
  });
});

describe('a carcass does NOT draw the wrong species', () => {
  it('a yellowtail bait school ignores it entirely', () => {
    const { withC, without } = compare('yellowtail', 30, 90);
    // Not "roughly the same" — identical. `chumPull` returns null for a non-scavenger before it
    // looks at a single carcass, so the step is bit-for-bit the run with no carcass in the water.
    expect(withC).toEqual(without);
  });

  it('nor does a billfish, a nurse shark, a dolphin or any reef schooler', () => {
    for (const type of ['nurse', 'dolphin', 'mangrove', 'bluerunner', 'schoolmaster']) {
      const { withC, without } = compare(type, 30, 60);
      expect(withC, type).toEqual(without);
    }
  });

  it('nor a tuna or a marlin — which need the weaker test, for a reason worth recording', () => {
    // `yellowfin` (`dMin: 30`) and `marlin` (`dMin: 40`) are deeper-water fish than the shelf at
    // this spot, so their lookahead leaves their own depth band and they take school.ts's
    // boundary-avoidance branch — which picks its turn direction with a bare `Math.random()`. Two
    // runs of identical code therefore differ for these species whatever chum does, so exact
    // equality is not available and asking for it would be asking for a flaky test. The question
    // that survives the noise is the one that matters: did the carcass pull them in?
    // (Measured: means within 5% of each other, either side.)
    for (const type of ['yellowfin', 'marlin']) {
      const { withC, without } = compare(type, 30, 60);
      expect(mean(withC), `${type}: with=${mean(withC).toFixed(1)} without=${mean(without).toFixed(1)}`)
        .toBeGreaterThan(mean(without) * 0.9);
    }
  });
});

describe('a resident scavenger keeps its own patch', () => {
  it('leans its patch toward the carcass without abandoning the reef for good', () => {
    // A resident barracuda with a 12 m patch 30 m from the carcass. It should visit — the lean is
    // capped under 1 (CARCASS_PULL), so the patch moves most of the way but not all of it — and
    // then be back on its own ground once the carcass is spent.
    const g = roamer('barracuda', CX - 30, CZ, 0.6);
    g.anchor = { x: CX - 30, z: CZ, r: 12 };
    g.resident = true;
    const visit = run(g, [createCarcass('c', CX, CZ)], 100);
    expect(visit.min, `never came over (${visit.min.toFixed(1)} m)`).toBeLessThan(18);
    const home = run(g, [], 150);
    const backHome = Math.hypot(g.cx - (CX - 30), g.cz - CZ);
    expect(backHome, `did not go home: ${backHome.toFixed(1)} m from its anchor, ${home.end.toFixed(1)} m from the carcass`).toBeLessThan(12 * 3.5);
  });
});
