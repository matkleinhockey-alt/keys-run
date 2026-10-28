/**
 * The tension bar reads load against what the line will take.
 *
 * The gauge has been wrong twice, in two different ways, and these pin both of them shut.
 *
 * 1. It showed raw tension on a fixed 0..1 scale while the line actually parts at `limit`, which
 *    falls to 0.45 as the leader chafes — so late in a fight it showed green where the line was
 *    already gone.
 * 2. Worse, on an ordinary fish the needle never moved out of the bottom half: measured over
 *    full fights a blackfin peaks at 0.72 tension at the tightest drag, against a red zone
 *    starting near 0.76. "Back off when the bar runs red" was unachievable for most of the game.
 * 3. And the mark was on the wrong quantity entirely. It was a fraction of the LINE limit, but
 *    most fish are lost to the HOOK pulling, which starts at a fixed tension (`HOOK_TEAR`).
 *    Measured cranking flat out, a 22 lb red grouper spends 12-24% of the fight tearing the
 *    hook and never once turned the bar red.
 */
import { describe, expect, it } from 'vitest';
import {
  HOOK_TEAR, SLACK_TENSION, warnFrac, tensionFrac,
  startFight, stepFight, fightParamsFor,
} from '../src/sim/fight.js';

describe('the tension gauge', () => {
  it('reads full exactly when the line is at its limit, worn or fresh', () => {
    for (const limit of [1, 0.8, 0.6, 0.45]) {
      expect(tensionFrac(limit, limit), `limit ${limit}`).toBeCloseTo(1, 10);
    }
  });

  it('shows a worn leader as closer to going, for the same pull', () => {
    const fresh = tensionFrac(0.5, 1);
    const worn = tensionFrac(0.5, 0.5);
    expect(worn).toBeGreaterThan(fresh);
    expect(worn).toBeCloseTo(1, 10);   // the same 0.5 that was half a bar is now all of it
  });

  it('puts the warning mark where the hook actually starts tearing', () => {
    // Fresh leader: the hook tears at 0.4 of a limit of 1, so the mark is at 40% of the bar.
    expect(warnFrac(1)).toBeCloseTo(HOOK_TEAR, 10);
  });

  it('closes the gap between tearing the hook and parting the line as the leader wears', () => {
    // The mark slides right as `limit` falls, because the hook tears at a fixed tension while
    // the bar is scaled to the line. The red band narrowing is the angler's room running out.
    const fresh = warnFrac(1), worn = warnFrac(0.6), gone = warnFrac(0.45);
    expect(worn).toBeGreaterThan(fresh);
    expect(gone).toBeGreaterThan(worn);
    expect(gone).toBeLessThanOrEqual(1);
  });

  it('never puts the mark off the end of the bar', () => {
    for (const limit of [1, 0.5, 0.3, 0.1, 0.01, 0]) {
      const w = warnFrac(limit);
      expect(Number.isFinite(w), `limit ${limit}`).toBe(true);
      expect(w).toBeGreaterThan(0);
      expect(w).toBeLessThanOrEqual(1);
    }
  });

  it('never divides by a collapsed limit', () => {
    for (const bad of [0, -1, Number.EPSILON]) {
      const f = tensionFrac(0.5, bad);
      expect(Number.isFinite(f), `limit ${bad}`).toBe(true);
      expect(f).toBeGreaterThan(0);
    }
  });

  /** Fight one flat out and report what the gauge did. */
  const fight = (key: string, weight: number, drag: number): { peakT: number; redFrac: number } => {
    let seed = 11;
    const rng = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const p = fightParamsFor(key, weight, drag);
    let f = startFight(p, -900, 2620, rng);
    let peakT = 0, red = 0, n = 0;
    for (let i = 0; i < 3600 && f.outcome === 'fighting'; i++) {
      f = stepFight(f, { reeling: true, drag }, p, { boatX: -900, boatZ: 2600 }, rng, 1 / 30);
      peakT = Math.max(peakT, f.tension);
      if (f.tension > HOOK_TEAR) red++;
      n++;
    }
    return { peakT, redFrac: red / Math.max(1, n) };
  };

  it('runs red on the fish people actually catch, which is the whole point', () => {
    // These are the two that broke it. Both tear the hook for a real part of the fight and
    // neither could make the old mark at any drag setting.
    expect(fight('redgrouper', 22, 3).redFrac, 'red grouper').toBeGreaterThan(0.08);
    expect(fight('blackfin', 30, 3).redFrac, 'blackfin').toBeGreaterThan(0.1);
  });

  it('still leaves a small fish green, because a small fish is safe', () => {
    // A gauge that is red all the time tells you no more than one that is never red. A 4 lb
    // snapper on this tackle cannot endanger itself and must read that way.
    const r = fight('lanesnapper', 4, 5);
    expect(r.peakT).toBeLessThan(HOOK_TEAR);
    expect(r.redFrac).toBe(0);
  });

  it('still shows the drag knob doing something', () => {
    // The reason the old fixed mark was picked. Time spent tearing has to rise with drag, or
    // the knob is invisible in the gauge and there is no reason to touch it.
    const light = fight('blackfin', 30, 1).redFrac;
    const hard = fight('blackfin', 30, 5).redFrac;
    expect(hard).toBeGreaterThan(light * 1.3);
  });

  it('warns about slack at the tension that actually throws the hook', () => {
    // stepFight's slack-wear term and the gauge's slack colour read the same constant, so the
    // bar cannot sit quiet while a jump is shaking the hook out.
    expect(SLACK_TENSION).toBeGreaterThan(0);
    expect(SLACK_TENSION).toBeLessThan(HOOK_TEAR);
  });
});
