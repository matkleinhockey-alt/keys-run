/**
 * Fish must come close to a diver who holds still.
 *
 * Underwater is the viewpoint the whole dive mode exists for, and the species' `diverRadius`
 * (3-9 m by behaviour class) used to apply at every diver speed — so simply hanging in the water
 * cleared a bubble of baitfish wider than you can see through, and the reef read as empty. It
 * also left almost nothing legitimately inside the speargun's 11 m range.
 *
 * Holding still must bring them in; finning hard must still push them off. This asserts both
 * ends, because fixing only the first would mean a diver could charge a shoal and it would
 * politely ignore them.
 */
import { describe, expect, it } from 'vitest';
import { stepSchool } from '../src/entities/fish/school.js';
import type { SchoolState, Threat } from '../src/entities/fish/types.js';
import { VIS } from '@keysrun/shared/content/creatures';

const DT = 1 / 30;
const DX = 300, DZ = 900;

function school(type: string, r: number, heading: number): SchoolState {
  const V = VIS[type];
  const members: SchoolState['members'] = Array.from({ length: Math.max(3, V.school[0]) }, (_, i) => ({
    ox: (i % 3) - 1, oz: Math.floor(i / 3) - 1, oy: 0, swimPhase: i * 0.7, seed: i * 0.7, bank: 0, scale: 1, sizeU: 0.5,
    act: null, actPhase: 0, actTimer: 2 + i, splashed: false, splashed2: false, breaching: false,
    wx: DX, wy: -4, wz: DZ, yaw: heading, pitch: 0, roll: 0, worldScale: 1,
  }));
  return {
    id: `p:${heading.toFixed(2)}`, type, cx: DX, cz: DZ, heading, phase: heading * 17.3,
    vx: 0, vz: 0, turnRate: 0, turn: 0, flee: 0, fleeHeading: heading, bowRide: 0, glide: 0, frenzy: 0, frenzyTimer: 0, dive: 0, diveTimer: 9,
    diveTarget: 0, anchor: { x: DX, z: DZ, r }, resident: true, members,
  };
}

/**
 * Closest the school centroid gets to the diver over `secs`, ignoring the first `SETTLE` seconds.
 *
 * The school is seeded on the diver (its patch is centred there), so without the settle window
 * this measures the starting overlap rather than any behaviour — which it did on the first
 * attempt, reporting 0.16 m for a sprinting diver who in fact drives them straight off.
 */
const SETTLE = 8;
function closest(type: string, diverSpeed: number, secs = 120): number {
  let best = Infinity;
  for (const h of [0, 1.1, 2.4, 3.9, 5.2]) {
    const g = school(type, 6, h);
    const V = VIS[g.type];
    const threats: Threat[] = [{ x: DX, z: DZ, kind: 'diver', speed: diverSpeed }];
    let t = 0;
    for (let i = 0; i < Math.round(secs / DT); i++) {
      t += DT;
      stepSchool(g, V, { t, dt: DT, threats });
      if (t < SETTLE) continue;
      best = Math.min(best, Math.hypot(g.cx - DX, g.cz - DZ));
    }
  }
  return best;
}

describe('fish and a diver', () => {
  it('come within a couple of metres of a diver holding still', () => {
    for (const type of ['yellowtail', 'barracuda']) {
      const d = closest(type, 0);
      expect(d, `${type} closest approach ${d.toFixed(2)} m`).toBeLessThan(2.5);
    }
  });

  it('still keep clear of a diver finning hard', () => {
    const d = closest('yellowtail', 2.5);
    expect(d, `closest approach to a sprinting diver ${d.toFixed(2)} m`).toBeGreaterThan(2.5);
  });

  it('give ground progressively as the diver speeds up', () => {
    const calm = closest('yellowtail', 0);
    const cruise = closest('yellowtail', 1.2);
    const sprint = closest('yellowtail', 2.5);
    expect(calm).toBeLessThan(cruise);
    expect(cruise).toBeLessThanOrEqual(sprint);
  });
});
