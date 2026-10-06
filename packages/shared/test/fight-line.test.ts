/**
 * The line-speed / spool model that drives the reel's drag clicker (apps/client/src/audio's
 * `updateReel`). These are the numbers the sound is derived from, so getting them wrong is
 * audible rather than invisible.
 */
import { describe, expect, it } from 'vitest';
import {
  spoolRadiusFor, startFight, stepFight,
  SPOOL_ARBOR_R, SPOOL_EMPTY_AT, SPOOL_FULL_R,
  type FightParams, type FightEnv,
} from '../src/sim/fight.js';
import { mulberry32 } from '../src/rng/index.js';

const PARAMS: FightParams = {
  key: 'mutton', weight: 12, str: 0.8, lenM: 1.2, maxLine: 190,
  jump: false, billfish: false, sounder: false, kingfish: false, drag: 3,
};
/** Open water off Sombrero Reef. (0,0) is on Vaca Key — a fish there breaks off in the mangroves
 * on the first tick (`landH > 0.2` in stepFight) and every lineSpeed assertion reads 0. */
const ENV: FightEnv = { boatX: 60, boatZ: 1400 };
const FISH_X = 60, FISH_Z = 1440;
const DT = 1 / 30;

describe('spoolRadiusFor', () => {
  it('starts full and falls to the arbor', () => {
    expect(spoolRadiusFor(0)).toBeCloseTo(SPOOL_FULL_R, 6);
    expect(spoolRadiusFor(SPOOL_EMPTY_AT)).toBeCloseTo(SPOOL_ARBOR_R, 6);
  });

  it('never goes below the arbor, even past the empty point', () => {
    expect(spoolRadiusFor(SPOOL_EMPTY_AT * 3)).toBeCloseTo(SPOOL_ARBOR_R, 6);
    expect(spoolRadiusFor(1e6)).toBeGreaterThan(0);
  });

  it('shrinks monotonically as line pays out', () => {
    let prev = Infinity;
    for (let m = 0; m <= SPOOL_EMPTY_AT; m += 20) {
      const r = spoolRadiusFor(m);
      expect(r).toBeLessThan(prev);
      prev = r;
    }
  });

  it('falls as a square root, not linearly — the pitch of a run should accelerate near the end', () => {
    // Line lies in layers, so radius tracks sqrt(remaining). Over the first half of the spool the
    // radius should drop by noticeably less than half of its total travel.
    const total = SPOOL_FULL_R - SPOOL_ARBOR_R;
    const firstHalfDrop = SPOOL_FULL_R - spoolRadiusFor(SPOOL_EMPTY_AT / 2);
    expect(firstHalfDrop).toBeLessThan(total * 0.5);
  });

  it('a given line speed spins an emptier spool faster', () => {
    const lineSpeed = 5;
    const rpsFull = lineSpeed / (2 * Math.PI * spoolRadiusFor(0));
    const rpsLow = lineSpeed / (2 * Math.PI * spoolRadiusFor(SPOOL_EMPTY_AT * 0.9));
    expect(rpsLow).toBeGreaterThan(rpsFull * 1.5);
  });
});

describe('lineSpeed', () => {
  it('is zero on the first tick rather than a spurious jump from dist 0', () => {
    const s0 = startFight(PARAMS, FISH_X, FISH_Z, mulberry32(7));
    expect(s0.lineSpeed).toBe(0);
    const s1 = stepFight(s0, { reeling: false }, PARAMS, ENV, mulberry32(7), DT);
    // startFight leaves dist at 0, so the first step must not report 40 m in one frame.
    expect(Math.abs(s1.lineSpeed)).toBeLessThan(5);
  });

  it('is positive while a fish runs away and negative while you gain line', () => {
    const rng = mulberry32(11);
    let s = startFight(PARAMS, FISH_X, FISH_Z, rng);
    s = stepFight(s, { reeling: false }, PARAMS, ENV, rng, DT); // seed dist

    // Drive the fish outward by hand so the sign is unambiguous rather than left to the run roll.
    let out = s;
    for (let i = 0; i < 30; i++) {
      out = { ...out, z: out.z + 0.25 };
      out = stepFight(out, { reeling: false }, PARAMS, ENV, rng, DT);
    }
    expect(out.lineSpeed).toBeGreaterThan(0);

    let back = out;
    for (let i = 0; i < 30; i++) {
      back = { ...back, z: back.z - 0.25 };
      back = stepFight(back, { reeling: true }, PARAMS, ENV, rng, DT);
    }
    expect(back.lineSpeed).toBeLessThan(0);
  });

  it('tracks the real rate rather than saturating — a fast run reads faster than a slow one', () => {
    const run = (step: number): number => {
      const rng = mulberry32(3);
      let s = startFight(PARAMS, FISH_X, FISH_Z, rng);
      s = stepFight(s, { reeling: false }, PARAMS, ENV, rng, DT);
      for (let i = 0; i < 40; i++) {
        s = { ...s, z: s.z + step };
        s = stepFight(s, { reeling: false }, PARAMS, ENV, rng, DT);
      }
      return s.lineSpeed;
    };
    expect(run(0.4)).toBeGreaterThan(run(0.1) * 2);
  });

  it('is smoothed, so the clicker sweeps instead of chattering frame to frame', () => {
    const rng = mulberry32(5);
    let s = startFight(PARAMS, FISH_X, FISH_Z, rng);
    s = stepFight(s, { reeling: false }, PARAMS, ENV, rng, DT);
    const before = s.lineSpeed;
    // One violent single-frame jerk must not slam lineSpeed to its raw instantaneous value.
    s = { ...s, z: s.z + 3 };
    s = stepFight(s, { reeling: false }, PARAMS, ENV, rng, DT);
    const raw = 3 / DT; // 90 m/s if taken unsmoothed
    expect(s.lineSpeed).toBeGreaterThan(before);
    expect(s.lineSpeed).toBeLessThan(raw * 0.6);
  });

  it('stays finite across a whole fight', () => {
    const rng = mulberry32(99);
    let s = startFight(PARAMS, FISH_X, FISH_Z, rng);
    for (let i = 0; i < 2000 && s.outcome === 'fighting'; i++) {
      s = stepFight(s, { reeling: i % 3 !== 0 }, PARAMS, ENV, rng, DT);
      expect(Number.isFinite(s.lineSpeed)).toBe(true);
      expect(Number.isFinite(s.spoolR)).toBe(true);
      expect(s.spoolR).toBeGreaterThan(0);
    }
  });
});
