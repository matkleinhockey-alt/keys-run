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
  const OFFSHORE = ['yellowfin', 'bluefin', 'albacore', 'blackfin', 'marlin', 'swordfish', 'wahoo',
    'mahi', 'sailfish', 'kingfish', 'barracuda', 'grouper', 'mangrove', 'yellowtail', 'gag'];
  /** What the spread is actually set for. */
  const TARGET = ['yellowfin', 'bluefin', 'albacore', 'blackfin', 'bigeye', 'skipjack',
    'marlin', 'blackmarlin', 'swordfish', 'wahoo'];

  function share(quality: number, of: readonly string[], n = 20000): number {
    let hit = 0;
    for (let i = 0; i < n; i++) {
      const k = pickTrollSpecies(OFFSHORE, quality, () => (i + 0.5) / n);
      if (k && of.includes(k)) hit++;
    }
    return hit / n;
  }

  it('is mostly tuna, marlin, swordfish and wahoo', () => {
    expect(share(1, TARGET)).toBeGreaterThan(0.6);
  });

  it('can still hook anything that is actually in the water', () => {
    // The list used to be a filter, so a grouper could not take a trolled lure at all. People do
    // catch odd things trolling; it should be uncommon, not impossible.
    const odd = share(0.5, ['grouper', 'mangrove', 'yellowtail', 'gag']);
    expect(odd).toBeGreaterThan(0.002);
    expect(odd).toBeLessThan(0.2);
  });

  it('includes every tuna, and the swordfish the old list left out entirely', () => {
    for (const k of ['yellowfin', 'bluefin', 'bigeye', 'albacore', 'blackfin', 'skipjack', 'swordfish']) {
      expect(TROLL_PREFERRED, `${k} should be one of the fish trolling is for`).toContain(k);
    }
  });

  it('a well-trimmed spread earns the good fish; a sloppy one takes what it is given', () => {
    expect(share(1, TARGET)).toBeGreaterThan(share(0, TARGET));
  });

  it('returns null only when there is nothing there at all', () => {
    expect(pickTrollSpecies([], 1)).toBeNull();
    // Inshore you now hook an inshore fish rather than nothing — but never a marlin.
    const inshore = new Set(Array.from({ length: 200 }, (_, i) =>
      pickTrollSpecies(['snook', 'redfish', 'trout', 'mangrove'], 1, () => (i + 0.5) / 200)));
    expect(inshore.size).toBeGreaterThan(0);
    for (const k of inshore) expect(['snook', 'redfish', 'trout', 'mangrove']).toContain(k);
  });
});

