/**
 * Where fish sit in the water column, and when a busting school comes up.
 *
 * `level: 'surface'` used to mean a flat `surf - 0.5` always, so a school of tuna was permanently
 * skimming the top whether it was feeding or not — from the helm the ocean looked like it had
 * tuna lying on it. And `bust`, the feeding act, fired on each member's own 2-8 s timer, which is
 * not a frenzy but a fidget. Tuna now cruise deep and the school busts together, occasionally.
 */
import { describe, expect, it } from 'vitest';
import { stepSchool } from '../src/entities/fish/school.js';
import type { SchoolState } from '../src/entities/fish/types.js';
import { VIS } from '@keysrun/shared/content/creatures';

const DT = 1 / 30;
const AX = 60, AZ = 2600; // open water offshore

function school(type: string): SchoolState {
  const V = VIS[type];
  const members: SchoolState['members'] = Array.from({ length: Math.max(4, V.school[0]) }, (_, i) => ({
    ox: (i % 3) - 1, oz: Math.floor(i / 3) - 1, oy: (i % 3) - 1, swimPhase: i * 0.7, seed: i * 0.7,
    bank: 0, scale: 1, sizeU: 0.5, act: null, actPhase: 0, actTimer: 2 + i,
    splashed: false, splashed2: false, breaching: false,
    wx: AX, wy: -4, wz: AZ, yaw: 0, pitch: 0, roll: 0, worldScale: 1,
  }));
  return { id: `d:${type}`, type, cx: AX, cz: AZ, heading: 0.4, phase: 1.1, vx: 0, vz: 0, turnRate: 0,
    turn: 0, flee: 0, fleeHeading: 0.4, bowRide: 0, glide: 0, frenzy: 0, frenzyTimer: 0, dive: 0,
    diveTimer: 9, diveTarget: 0, anchor: null, resident: false, members };
}

/** Runs `secs` and reports how the school sat relative to the surface (y=0 is roughly the top). */
function run(type: string, secs: number) {
  const g = school(type);
  const V = VIS[type];
  let t = 0, frenzySecs = 0, deepest = -Infinity, shallowestWhileCalm = -Infinity, brokeSurface = 0;
  const depths: number[] = [];
  for (let i = 0; i < Math.round(secs / DT); i++) {
    t += DT;
    stepSchool(g, V, { t, dt: DT, threats: [] });
    const avgY = g.members.reduce((a, m) => a + m.wy, 0) / g.members.length;
    depths.push(-avgY);
    if (g.frenzy > 0) frenzySecs += DT;
    else shallowestWhileCalm = Math.max(shallowestWhileCalm, avgY);
    deepest = Math.max(deepest, -avgY);
    for (const m of g.members) if (m.wy > 0) brokeSurface++;
  }
  const mean = depths.reduce((a, b) => a + b, 0) / depths.length;
  return { meanDepth: mean, frenzyFraction: frenzySecs / secs, shallowestWhileCalm, brokeSurface };
}

describe('where fish sit in the column', () => {
  it('keeps tuna off the top between frenzies', () => {
    const r = run('yellowfin', 240);
    // It used to sit at 0.5-0.8 m the entire time. Calm tuna should be metres down.
    expect(-r.shallowestWhileCalm, 'shallowest a calm school got').toBeGreaterThan(2);
    expect(r.meanDepth, 'mean depth over four minutes').toBeGreaterThan(2);
  });

  it('makes a frenzy an event, not the resting state', () => {
    const r = run('yellowfin', 300);
    expect(r.frenzyFraction).toBeGreaterThan(0.02); // it does happen
    expect(r.frenzyFraction).toBeLessThan(0.4);     // and it is not most of the time
  });

  it('does bring the school up when one is on', () => {
    const g = school('bluefin');
    const V = VIS.bluefin;
    let t = 0, calm = -Infinity, hot = -Infinity;
    for (let i = 0; i < Math.round(400 / DT); i++) {
      t += DT;
      stepSchool(g, V, { t, dt: DT, threats: [] });
      const avgY = g.members.reduce((a, m) => a + m.wy, 0) / g.members.length;
      if (g.frenzy > 0) hot = Math.max(hot, avgY); else calm = Math.max(calm, avgY);
    }
    expect(hot, 'a busting school never came up').toBeGreaterThan(calm);
  });

  it('leaves bottom-dwellers on the bottom', () => {
    const r = run('grouper', 60);
    expect(r.meanDepth).toBeGreaterThan(3);
  });

  it('sits mid-water fish below the surface, not on it', () => {
    const r = run('mangrove', 60);
    expect(r.meanDepth).toBeGreaterThan(0.8);
  });
});
