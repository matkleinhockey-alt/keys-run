/**
 * Trolling's rules: the speed window, how long a strike takes to come, and what eats.
 *
 * The speed band is the whole mechanic — it is what makes trolling something you TRIM rather than
 * a mode you switch on — so most of this is about making sure being wrong about the throttle
 * costs you proportionally rather than absolutely.
 */
import { describe, expect, it } from 'vitest';
import {
  TROLL_SPEED_MIN, TROLL_SPEED_MAX, TROLL_SPEED_TARGET, TROLL_MIN_GAP_S, TROLL_PREFERRED,
  trollQuality, createTrollState, setLinesOut, stepTroll, pickTrollSpecies,
} from '../src/sim/troll.js';

const DT = 1 / 30;
/** Seconds of trolling at `speed` before the first strike, or null if it never comes. */
function timeToStrike(speed: number, richness = 1, cap = 4000): number | null {
  let s = setLinesOut(createTrollState(), true, () => 0.5);
  let t = 0;
  while (t < cap) {
    const r = stepTroll(s, { speed, richness }, DT, () => 0.5);
    s = r.state; t += DT;
    if (r.strike) return t;
  }
  return null;
}

describe('the speed window', () => {
  it('peaks at the target speed and is zero outside the band', () => {
    expect(trollQuality(TROLL_SPEED_TARGET)).toBeGreaterThan(0.99);
    expect(trollQuality(TROLL_SPEED_MIN)).toBe(0);
    expect(trollQuality(TROLL_SPEED_MAX)).toBe(0);
    expect(trollQuality(0)).toBe(0);
    expect(trollQuality(12)).toBe(0);
  });

  it('falls off smoothly rather than over a cliff', () => {
    // The player has to be able to FEEL themselves getting warmer as they trim the throttle. A
    // plateau with hard edges is a gate you pass once and then stop thinking about.
    const mid = trollQuality(TROLL_SPEED_TARGET);
    const near = trollQuality(TROLL_SPEED_TARGET + 0.3);
    const edge = trollQuality(TROLL_SPEED_MAX - 0.1);
    expect(near).toBeLessThan(mid);
    expect(edge).toBeLessThan(near);
    expect(edge).toBeGreaterThan(0);
  });

  it('treats astern the same as ahead — it is the water going past the lure that matters', () => {
    expect(trollQuality(-TROLL_SPEED_TARGET)).toBeCloseTo(trollQuality(TROLL_SPEED_TARGET), 10);
  });
});

describe('waiting for a strike', () => {
  it('nothing ever eats outside the band, however long you drag', () => {
    expect(timeToStrike(1.2)).toBeNull();
    expect(timeToStrike(8)).toBeNull();
  });

  it('a well-trimmed boat gets bitten, and sooner than a badly-trimmed one', () => {
    const good = timeToStrike(TROLL_SPEED_TARGET);
    const ragged = timeToStrike(TROLL_SPEED_MAX - 0.15);
    expect(good).not.toBeNull();
    expect(ragged).not.toBeNull();
    expect(ragged!).toBeGreaterThan(good! * 2);
  });

  it('richer water fishes faster, in proportion', () => {
    const plain = timeToStrike(TROLL_SPEED_TARGET, 1)!;
    const rich = timeToStrike(TROLL_SPEED_TARGET, 3)!;
    expect(rich).toBeLessThan(plain);
    expect(rich).toBeCloseTo(plain / 3, 0);
  });

  it('never fires twice in a handful of seconds, even on the luckiest roll', () => {
    // A hookup every few seconds is a slot machine. `TROLL_MIN_GAP_S` is the floor and it has to
    // hold against an rng that always returns its most generous value.
    let s = setLinesOut(createTrollState(), true, () => 0);
    let t = 0, first: number | null = null;
    while (t < 2000) {
      const r = stepTroll(s, { speed: TROLL_SPEED_TARGET, richness: 50 }, DT, () => 0);
      s = r.state; t += DT;
      if (r.strike) { if (first === null) first = t; else { expect(t - first).toBeGreaterThanOrEqual(TROLL_MIN_GAP_S - 0.5); return; } }
    }
    throw new Error('expected two strikes');
  });

  it('does nothing at all with the lines in', () => {
    const s = createTrollState();
    for (let i = 0; i < 3000; i++) expect(stepTroll(s, { speed: TROLL_SPEED_TARGET, richness: 5 }, DT).strike).toBe(false);
  });

  it('putting the lines out resets the clock rather than inheriting the last set', () => {
    let s = setLinesOut(createTrollState(), true, () => 0.5);
    for (let i = 0; i < 1200; i++) s = stepTroll(s, { speed: TROLL_SPEED_TARGET, richness: 1 }, DT, () => 0.5).state;
    const spent = s.untilStrike;
    s = setLinesOut(s, false, () => 0.5);
    s = setLinesOut(s, true, () => 0.5);
    expect(s.untilStrike).toBeGreaterThan(spent);
    expect(s.soak).toBe(0);
  });
});

describe('what eats a trolled lure', () => {
  it('prefers the fast pelagics the mechanic exists for', () => {
    const offshore = ['mahi', 'sailfish', 'blackfin', 'yellowtail', 'mangrove', 'grouper'];
    const picks = new Set(Array.from({ length: 40 }, (_, i) => pickTrollSpecies(offshore, 1, () => i / 40)));
    for (const p of picks) expect(TROLL_PREFERRED, `${p} is not a trolling fish`).toContain(p);
    expect(picks.has('grouper')).toBe(false);
  });

  it('a well-trimmed spread reaches the better fish; a sloppy one takes what it is given', () => {
    const table = ['sailfish', 'marlin', 'mahi', 'wahoo', 'kingfish', 'blackfin', 'cero'];
    // rng at its lowest always takes the first entry it is allowed to reach, so `reach` is what
    // separates the two cases.
    const clean = pickTrollSpecies(table, 1, () => 0.999);
    const sloppy = pickTrollSpecies(table, 0, () => 0.999);
    expect(TROLL_PREFERRED.indexOf(clean!)).toBeLessThan(TROLL_PREFERRED.indexOf(sloppy!));
  });

  it('returns null inshore rather than inventing a sailfish in four feet of water', () => {
    expect(pickTrollSpecies(['snook', 'redfish', 'trout', 'mangrove'], 1)).toBeNull();
    expect(pickTrollSpecies([], 1)).toBeNull();
  });
});
