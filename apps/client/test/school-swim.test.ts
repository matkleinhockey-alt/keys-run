/**
 * How a school LOOKS as it swims, pinned as numbers rather than left to a screenshot.
 *
 * Two things were wrong and are easy to regress, because both are invisible in a still frame:
 *
 *  1. Every fish of a species beat its tail at exactly the same rate, whatever it was doing. The
 *     swim cycle is baked into one VAT advanced by a single global clock (vat.ts), and each
 *     member's `swimPhase` was a fixed offset, so a school milling over its patch at 0.75x cruise
 *     and a school bolting at 2.2x animated identically.
 *  2. Nothing banked. A school would yaw through a turn perfectly upright, which is the most
 *     obvious thing a real school does that a yaw-only one does not.
 *
 * `swimPhase` is now the advancing phase handed to the GPU, and `seed` is the fixed per-member
 * offset the wander sines want — mixing those up is the regression this file is here to catch:
 * the wander would start running at a speed that depends on how fast the school is swimming.
 */
import { describe, expect, it } from 'vitest';
import { stepSchool } from '../src/entities/fish/school.js';
import type { SchoolState, Threat } from '../src/entities/fish/types.js';
import { VIS } from '@keysrun/shared/content/creatures';

const DT = 1 / 30;
const AX = 300, AZ = 900;

function school(type: string, r = 10): SchoolState {
  const V = VIS[type];
  const members: SchoolState['members'] = Array.from({ length: Math.max(3, V.school[0]) }, (_, i) => ({
    ox: (i % 3) - 1, oz: Math.floor(i / 3) - 1, oy: 0, swimPhase: i * 0.7, seed: i * 0.7, bank: 0, scale: 1, sizeU: 0.5,
    act: null, actPhase: 0, actTimer: 1e6, splashed: false, splashed2: false, breaching: false,
    wx: AX, wy: -4, wz: AZ, yaw: 0, pitch: 0, roll: 0, worldScale: 1,
  }));
  return {
    id: `s:${type}`, type, cx: AX, cz: AZ, heading: 0, phase: 1.1,
    vx: 0, vz: 0, turnRate: 0, turn: 0, flee: 0, fleeHeading: 0, bowRide: 0, glide: 0, dive: 0, diveTimer: 1e6,
    diveTarget: 0, anchor: { x: AX, z: AZ, r }, resident: true, members,
  };
}

/** Phase advanced by member 0 over `secs`, the widest roll any member reached, and whether the
 * school was ever actually spooked — `flee` is a 1.5 s countdown, so reading it after the run
 * says nothing about whether it ever fired. */
function run(g: SchoolState, threats: Threat[], secs: number): { phase: number; maxRoll: number; fled: boolean } {
  const V = VIS[g.type];
  const p0 = g.members[0].swimPhase;
  let t = 0, maxRoll = 0, fled = false;
  for (let i = 0; i < Math.round(secs / DT); i++) {
    t += DT;
    stepSchool(g, V, { t, dt: DT, threats });
    if (g.flee > 0) fled = true;
    for (const m of g.members) maxRoll = Math.max(maxRoll, Math.abs(m.roll));
  }
  return { phase: g.members[0].swimPhase - p0, maxRoll, fled };
}

describe('tail-beat rate follows how fast the fish is actually going', () => {
  it('a school bolting from a diver beats faster than the same school at rest', () => {
    const calm = run(school('yellowtail'), [], 6);
    const spooked = school('yellowtail');
    // a diver swimming hard, right on top of them: behavior.ts's flee trigger
    const threat: Threat = { kind: 'diver', x: AX, z: AZ, speed: 2.5 };
    const fled = run(spooked, [threat], 6);
    expect(fled.fled, 'the school never actually fled, so this proves nothing').toBe(true);
    expect(fled.phase).toBeGreaterThan(calm.phase);
  });

  it('a school holding its patch beats SLOWER than cruise, not frozen', () => {
    // Anchored schools run at 0.75x cruise (school.ts), so the accumulated phase goes negative —
    // the fish is behind the global clock, which is what "beating slower" means here.
    const g = school('yellowtail');
    const { phase } = run(g, [], 6);
    expect(phase).toBeLessThan(0);
    // ...but it still sculls. BEAT_MIN keeps the rate off zero; a frozen tail reads as a dead fish.
    expect(phase).toBeGreaterThan(-6 * 7.5);
  });

  it('the formation wander is NOT driven by the advancing phase', () => {
    // `seed` must stay put. If the wander were moved onto `swimPhase`, its frequency would drift
    // with the school's speed and the formation would visibly churn whenever the school sped up.
    const g = school('yellowtail');
    const seeds = g.members.map((m) => m.seed);
    run(g, [], 4);
    expect(g.members.map((m) => m.seed)).toEqual(seeds);
    expect(g.members[0].swimPhase).not.toBe(seeds[0]);
  });
});

describe('fish bank into a turn', () => {
  it('a school driven into a hard turn rolls, and rolls the way it is turning', () => {
    const g = school('yellowtail');
    // Drive the heading round by parking a threat that keeps moving: the flee heading chases it,
    // which is the sharpest sustained turn the sim produces short of the world boundary.
    let t = 0, signed = 0, seen = 0;
    for (let i = 0; i < 30 * 8; i++) {
      t += DT;
      const a = t * 1.6;
      stepSchool(g, VIS.yellowtail, { t, dt: DT, threats: [{ kind: 'diver', x: AX + Math.cos(a) * 3, z: AZ + Math.sin(a) * 3, speed: 2.5 }] });
      if (Math.abs(g.turnRate) > 0.05) { signed += Math.sign(g.turnRate) * g.members[0].roll < 0 ? 1 : -1; seen++; }
    }
    expect(seen, 'the school never turned hard enough to test the bank').toBeGreaterThan(30);
    // A fish leans INTO the corner: roll opposes the sign of the turn rate.
    expect(signed).toBeGreaterThan(0);
  });

  it('never rolls a fish past the bank cap', () => {
    const g = school('yellowtail');
    const { maxRoll } = run(g, [{ kind: 'diver', x: AX, z: AZ, speed: 3 }], 10);
    expect(maxRoll).toBeLessThan(0.4); // BANK_MAX plus the species' own roll term
  });
});
