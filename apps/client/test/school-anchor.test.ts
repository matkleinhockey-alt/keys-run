/**
 * A resident school must HOLD its patch without orbiting it.
 *
 * The bug this pins: steering an anchored school with a tangential term plus a radial correction
 * toward radius R makes that circle a stable attractor. Every school converges onto it and turns
 * the same way forever, which over a bait frenzy — where the player is parked watching one patch —
 * reads exactly as "the fish are spinning in circles".
 *
 * Circling is not detectable from a single frame, so this integrates the heading over several
 * simulated minutes and asks how far it wound: a carousel racks up whole turns the same way, a
 * milling school's net winding stays near zero.
 *
 * A radius-spread check was tried first and dropped — it passed against the buggy code as well,
 * because both versions start at the anchor and spiral outward, so the spread is ~12 m either
 * way. Winding is the only measure that separates them.
 */
import { describe, expect, it } from 'vitest';
import { stepSchool } from '../src/entities/fish/school.js';
import type { SchoolState } from '../src/entities/fish/types.js';
import { VIS } from '@keysrun/shared/content/creatures';

const DT = 1 / 30;
/** Open water on the reef line, deep enough that depth clamping doesn't dominate the path. */
const AX = 300, AZ = 900;

function resident(type: string, r: number, heading: number): SchoolState {
  const V = VIS[type];
  const members: SchoolState['members'] = Array.from({ length: Math.max(3, V.school[0]) }, (_, i) => ({
    ox: (i % 3) - 1, oz: Math.floor(i / 3) - 1, oy: 0, swimPhase: i * 0.7, scale: 1, sizeU: 0.5,
    act: null, actPhase: 0, actTimer: 2 + i, splashed: false, splashed2: false, breaching: false,
    wx: AX, wy: -4, wz: AZ, yaw: heading, pitch: 0, roll: 0, worldScale: 1,
  }));
  return {
    id: `t:${type}:${heading.toFixed(2)}`, type,
    cx: AX, cz: AZ, heading, phase: heading * 17.3, turn: 0, flee: 0, fleeHeading: heading,
    bowRide: 0, glide: 0, dive: 0, diveTimer: 9, diveTarget: 0,
    anchor: { x: AX, z: AZ, r }, resident: true, members,
  };
}

/** Runs `secs` and reports how far the heading wound (in whole turns) and the radius spread. */
function run(g: SchoolState, secs: number): { turns: number; rMin: number; rMax: number } {
  const V = VIS[g.type];
  let t = 0, prev = g.heading, wound = 0, rMin = Infinity, rMax = 0;
  for (let i = 0; i < Math.round(secs / DT); i++) {
    t += DT;
    stepSchool(g, V, { t, dt: DT, threats: [] });
    let d = g.heading - prev;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    wound += d;
    prev = g.heading;
    const r = Math.hypot(g.cx - AX, g.cz - AZ);
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
  }
  return { turns: wound / (Math.PI * 2), rMin, rMax };
}

describe('a resident school holding its patch', () => {
  // Several headings: the old carousel wound at the same rate regardless of where it started,
  // so one starting angle could never have caught it.
  const headings = [0, 1.1, 2.4, 3.9, 5.2];

  it('does not wind up whole turns in one direction', () => {
    for (const h of headings) {
      const { turns } = run(resident('yellowtail', 11, h), 240);
      // Measured against the buggy version, every start angle wound 4.17-4.43 turns in these
      // four minutes; the fix gives -0.03 to 1.21. 2.5 sits in the gap with margin on both sides.
      expect(Math.abs(turns), `heading ${h.toFixed(1)} wound ${turns.toFixed(1)} turns`).toBeLessThan(2.5);
    }
  });

  it('still holds the patch — it does not wander off', () => {
    for (const h of headings) {
      const g = resident('yellowtail', 11, h);
      run(g, 240);
      const d = Math.hypot(g.cx - AX, g.cz - AZ);
      expect(d, `heading ${h.toFixed(1)} ended ${d.toFixed(0)} m out`).toBeLessThan(11 * 3.5);
    }
  });

  it('holds for a bigger-bodied school too', () => {
    const g = resident('barracuda', 14, 2.0);
    const { turns } = run(g, 240);
    expect(Math.abs(turns)).toBeLessThan(2.5);
    expect(Math.hypot(g.cx - AX, g.cz - AZ)).toBeLessThan(14 * 3.5);
  });
});
