/**
 * Fish nose into a dive instead of travelling level.
 *
 * Outside the set-piece acts (a bust, a porpoise, a tail-walk) `pitch` was fixed at 0, so a
 * school changing depth stayed perfectly flat and moved straight up or down — fish as lifts.
 * It is now the fish's own path angle: how fast it is going up or down against how fast it is
 * going along, faded out as it stops (a path angle means nothing without a path).
 *
 * No test here forces a stopped school: `stepSchool` recomputes the school's velocity every
 * frame, so zeroing it from outside does nothing, and measurement says schools never slow below
 * about 0.6x cruise anyway.
 *
 * These assert on the MEDIAN, not the peak. A level school still drifts: it follows the bottom
 * contour and its members sit at different heights in the column, so individual frames reach
 * 25 degrees quite legitimately. What separates swimming level from going down is where the
 * body sits most of the time — measured, 7.7 degrees against 17.1.
 */
import { describe, expect, it } from 'vitest';
import { stepSchool } from '../src/entities/fish/school.js';
import type { SchoolState } from '../src/entities/fish/types.js';
import { VIS } from '@keysrun/shared/content/creatures';

const DT = 1 / 30;
const AX = 60, AZ = 2600; // open water offshore
/** The fixture drops members in at wy -4 while the school sits ~40 m down; this is that fall. */
const SETTLE = Math.round(1.5 / DT);

function school(type: string, dive: number): SchoolState {
  const V = VIS[type];
  const members: SchoolState['members'] = Array.from({ length: Math.max(4, V.school[0]) }, (_, i) => ({
    ox: (i % 3) - 1, oz: Math.floor(i / 3) - 1, oy: (i % 3) - 1, swimPhase: i * 0.7, seed: i * 0.7,
    bank: 0, climb: 0, scale: 1, sizeU: 0.5, act: null, actPhase: 0, actTimer: 600,
    splashed: false, splashed2: false, breaching: false,
    wx: AX, wy: -4, wz: AZ, yaw: 0, pitch: 0, roll: 0, worldScale: 1,
  }));
  return { id: `c:${type}`, type, cx: AX, cz: AZ, heading: 0.4, phase: 1.1, vx: 0, vz: 0, turnRate: 0,
    turn: 0, flee: 0, fleeHeading: 0.4, bowRide: 0, glide: 0, frenzy: 0, frenzyTimer: 0, dive,
    diveTimer: 9999, diveTarget: 0, anchor: null, resident: false, members };
}

function run(type: string, secs: number, dive: number) {
  const g = school(type, dive);
  const V = VIS[type];
  let t = 0;
  const abs: number[] = [], signed: number[] = [];
  for (let i = 0; i < Math.round(secs / DT) + SETTLE; i++) {
    t += DT;
    g.dive = dive; // hold the dive on, the way a threat would
    stepSchool(g, V, { t, dt: DT, threats: [] });
    if (i < SETTLE) continue;
    for (const m of g.members) { abs.push(Math.abs(m.pitch)); signed.push(m.pitch); }
  }
  abs.sort((a, b) => a - b);
  const median = abs[abs.length >> 1];
  return { median, peak: abs[abs.length - 1], mean: signed.reduce((a, b) => a + b, 0) / signed.length };
}

describe('fish nose into a change of depth', () => {
  it('a diving school is more than twice as steep as a level one, and noses DOWN', () => {
    const level = run('yellowtail', 10, 0);
    const diving = run('yellowtail', 10, 1);
    console.log(`  level  median ${(level.median * 57.3).toFixed(1)}deg  mean ${(level.mean * 57.3).toFixed(1)}deg`);
    console.log(`  diving median ${(diving.median * 57.3).toFixed(1)}deg  mean ${(diving.mean * 57.3).toFixed(1)}deg`);
    expect(diving.median).toBeGreaterThan(level.median * 1.8);
    expect(diving.mean).toBeLessThan(level.mean); // on average pointed downward, not just steeper
  });

  it('swimming level keeps the body near level most of the time', () => {
    const r = run('yellowtail', 10, 0);
    expect(r.median).toBeLessThan(0.25); // ~14deg: drifting over the contour, not climbing
  });

  it('nothing ever goes end over end, for any species', () => {
    for (const type of ['yellowtail', 'tarpon', 'mahi', 'grouper', 'bonefish', 'stingray']) {
      for (const dive of [0, 1]) {
        const r = run(type, 4, dive);
        expect(Number.isFinite(r.peak)).toBe(true);
        expect(r.peak).toBeLessThanOrEqual(1.2); // the acts may exceed CLIMB_MAX; nothing may spin
      }
    }
  });

  it('spawning does not throw a fish end over end on its first frame', () => {
    const g = school('yellowtail', 0);
    for (const m of g.members) m.wy = 0; // fresh member, metres above where it belongs
    stepSchool(g, VIS.yellowtail, { t: 0.01, dt: DT, threats: [] });
    for (const m of g.members) expect(Math.abs(m.pitch)).toBeLessThanOrEqual(0.5 + 1e-6);
  });
});
