/**
 * A spooked school must swim AWAY from what spooked it.
 *
 * The bug this pins: `fleeHeading` was built with `atan2(-dx, -dz)`, which in this heading
 * convention (forward is `(-sin h, -cos h)`) is the *toward* form — the same expression
 * bow-riding uses a few lines later to close on a boat's bow. So a spooked school swam straight
 * at whatever spooked it, re-entered the trigger radius, re-triggered, and orbited it. Under a
 * stopped boat that is a ring of fish lapping the hull roughly once a second, which is how it was
 * reported: "the fish spin under the boat".
 *
 * Direction is the real assertion; the winding check is what catches a regression that gets the
 * direction right on frame one but still traps the school in a loop.
 */
import { describe, expect, it } from 'vitest';
import { stepSchool } from '../src/entities/fish/school.js';
import type { SchoolState, Threat } from '../src/entities/fish/types.js';
import { VIS } from '@keysrun/shared/content/creatures';

const DT = 1 / 30;
const AX = 300, AZ = 900;
/** behavior.ts's HULL_CLEAR_RADIUS — a stopped boat spooks fish only inside its own volume. */
const HULL_CLEAR = 7.5;

function school(type: string, r: number, heading: number): SchoolState {
  const V = VIS[type];
  const members: SchoolState['members'] = Array.from({ length: Math.max(3, V.school[0]) }, (_, i) => ({
    ox: (i % 3) - 1, oz: Math.floor(i / 3) - 1, oy: 0, swimPhase: i * 0.7, scale: 1,
    act: null, actPhase: 0, actTimer: 2 + i, splashed: false, splashed2: false, breaching: false,
    wx: AX, wy: -4, wz: AZ, yaw: heading, pitch: 0, roll: 0, worldScale: 1,
  }));
  return {
    id: `f:${heading.toFixed(2)}`, type, cx: AX, cz: AZ, heading, phase: heading * 17.3,
    turn: 0, flee: 0, fleeHeading: heading, bowRide: 0, glide: 0, dive: 0, diveTimer: 9,
    diveTarget: 0, anchor: { x: AX, z: AZ, r }, resident: true, members,
  };
}

function run(g: SchoolState, threats: Threat[], secs: number): { turns: number; dist: number } {
  const V = VIS[g.type];
  let t = 0, prev = g.heading, wound = 0;
  for (let i = 0; i < Math.round(secs / DT); i++) {
    t += DT;
    stepSchool(g, V, { t, dt: DT, threats });
    let d = g.heading - prev;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    wound += d;
    prev = g.heading;
  }
  const th = threats[0];
  return { turns: wound / (Math.PI * 2), dist: Math.hypot(g.cx - th.x, g.cz - th.z) };
}

describe('a spooked school', () => {
  const headings = [0, 1.1, 2.4, 3.9, 5.2];

  it('moves away from a stopped boat sitting on top of it, not into it', () => {
    for (const h of headings) {
      const g = school('yellowtail', 6, h);
      // Boat right on the school, well inside the hull-clearance radius.
      const { dist } = run(g, [{ x: AX, z: AZ, kind: 'boat', speed: 0 }], 6);
      expect(dist, `heading ${h.toFixed(1)} ended ${dist.toFixed(1)} m from the hull`).toBeGreaterThan(HULL_CLEAR * 0.8);
    }
  });

  it('does not orbit the boat it is shying off', () => {
    // The old code lapped the hull ~257 times in four simulated minutes, at every anchor radius —
    // the radius-independence is what identified this as the flee path and not the anchor.
    for (const r of [3, 5, 7, 9]) {
      for (const h of headings) {
        const g = school('yellowtail', r, h);
        const { turns } = run(g, [{ x: AX, z: AZ, kind: 'boat', speed: 0 }], 240);
        expect(Math.abs(turns), `R=${r} heading ${h.toFixed(1)} wound ${turns.toFixed(1)} turns`).toBeLessThan(12);
      }
    }
  });

  it('moves away from a diver too', () => {
    for (const h of headings) {
      const g = school('yellowtail', 6, h);
      const { dist } = run(g, [{ x: AX, z: AZ, kind: 'diver', speed: 1 }], 6);
      expect(dist, `heading ${h.toFixed(1)} ended ${dist.toFixed(1)} m from the diver`).toBeGreaterThan(4);
    }
  });
});
