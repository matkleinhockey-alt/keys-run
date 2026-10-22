import { describe, expect, it } from 'vitest';
import {
  PIRATE_JOIN_GRACE_S, PIRATE_PERIOD_S, PIRATE_POOLS, PIRATE_START_HI, PIRATE_START_LO,
  appraiseLoot, nextPirateVisit, pirateBucket, pirateScript, pirateVisit, pirateVisitDue,
  type PirateLoot,
} from '../src/world/pirates.js';

const SEED = 20240817;
const loot = (over: Partial<PirateLoot> = {}): PirateLoot => ({ cash: 0, coolerLb: 0, coolerCount: 0, coolerCap: 350, boat: 'Grady-White Actively Sinking', ...over });

describe('the schedule', () => {
  it('is a pure function of (seed, time): same inputs, same answer, any order', () => {
    const a = [5, 900, 12, 5].map((b) => pirateVisit(SEED, b));
    expect(a[0]).toEqual(a[3]);
    expect(pirateVisit(SEED, 900)).toEqual(a[1]);
    expect(pirateVisit(SEED + 1, 5)).not.toEqual(a[0]);
  });

  it('starts every visit in the middle slice of its 30-minute bucket', () => {
    for (let b = 0; b < 2000; b++) {
      const v = pirateVisit(SEED, b);
      expect(v.start).toBeGreaterThanOrEqual(b * PIRATE_PERIOD_S + PIRATE_START_LO * PIRATE_PERIOD_S);
      expect(v.start).toBeLessThanOrEqual(b * PIRATE_PERIOD_S + PIRATE_START_HI * PIRATE_PERIOD_S);
    }
  });

  it('comes by about every 30 minutes: gaps between 24 and 36 min, averaging 30', () => {
    let sum = 0, min = Infinity, max = 0;
    const N = 5000;
    for (let b = 0; b < N; b++) {
      const gap = pirateVisit(SEED, b + 1).start - pirateVisit(SEED, b).start;
      sum += gap; min = Math.min(min, gap); max = Math.max(max, gap);
    }
    expect(min / 60).toBeGreaterThanOrEqual(24 - 1e-9);
    expect(max / 60).toBeLessThanOrEqual(36 + 1e-9);
    expect(sum / N / 60).toBeGreaterThan(29.5);
    expect(sum / N / 60).toBeLessThan(30.5);
  });

  it('uses both seas, and both sides of each', () => {
    const seas = new Set<string>(), signs = new Set<number>();
    for (let b = 0; b < 200; b++) { const v = pirateVisit(SEED, b); seas.add(v.sea); signs.add(Math.sign(v.spread)); }
    expect([...seas].sort()).toEqual(['channel', 'gulf']);
    expect(signs.has(-1) && signs.has(1)).toBe(true);
  });
});

describe('"are they due" with an injected clock', () => {
  const b = 1234;
  const v = pirateVisit(SEED, b);

  it('is not due before the start, with no waiting involved', () => {
    expect(pirateVisitDue(SEED, v.start - 1, -Infinity)).toBeNull();
    expect(pirateVisitDue(SEED, b * PIRATE_PERIOD_S, -Infinity)).toBeNull();
  });

  it('is due from the start, and on time inside the grace window', () => {
    const due = pirateVisitDue(SEED, v.start + 3, -Infinity)!;
    expect(due.visit.bucket).toBe(b);
    expect(due.missed).toBe(false);
    expect(due.lateS).toBeCloseTo(3, 6);
    expect(pirateVisitDue(SEED, v.start + PIRATE_JOIN_GRACE_S, -Infinity)!.missed).toBe(false);
  });

  it('writes off a visit you joined too late for, instead of materialising them', () => {
    expect(pirateVisitDue(SEED, v.start + PIRATE_JOIN_GRACE_S + 1, -Infinity)!.missed).toBe(true);
    expect(pirateVisitDue(SEED, v.start + 5 * 60, -Infinity)!.missed).toBe(true);
  });

  it('never fires twice for one bucket once handled', () => {
    expect(pirateVisitDue(SEED, v.start + 3, b)).toBeNull();
    expect(pirateVisitDue(SEED, v.start + 100, b)).toBeNull();
  });

  it('fires exactly once per bucket when walked through three hours at 1 Hz', () => {
    const t0 = 1_760_000_000;
    let handled = -Infinity;
    const fired: number[] = [];
    for (let t = t0; t < t0 + 3 * 3600; t++) {
      const due = pirateVisitDue(SEED, t, handled);
      if (!due) continue;
      handled = due.visit.bucket;
      if (!due.missed) fired.push(due.visit.bucket);
    }
    // 3 h = 6 buckets, +1 if the window straddles a boundary. The first may be missed (we joined
    // mid-bucket past the window), never more than one per bucket.
    expect(new Set(fired).size).toBe(fired.length);
    expect(fired.length).toBeGreaterThanOrEqual(5);
    expect(fired.length).toBeLessThanOrEqual(7);
  });

  it('nextPirateVisit is always in the future and is the very next one', () => {
    for (let i = 0; i < 500; i++) {
      const now = 1_760_000_000 + i * 397;
      const n = nextPirateVisit(SEED, now);
      expect(n.start).toBeGreaterThan(now);
      expect(n.start - now).toBeLessThanOrEqual(PIRATE_PERIOD_S * 1.2);
      expect(pirateBucket(n.start)).toBe(n.bucket);
    }
  });
});

describe('reading the player', () => {
  it('sorts the cooler and the wallet into the right category', () => {
    expect(appraiseLoot(loot())).toBe('broke');
    expect(appraiseLoot(loot({ cash: 40 }))).toBe('broke');
    expect(appraiseLoot(loot({ cash: 700 }))).toBe('pocketChange');
    expect(appraiseLoot(loot({ coolerCount: 2, coolerLb: 20 }))).toBe('someFish');
    expect(appraiseLoot(loot({ coolerCount: 9, coolerLb: 300 }))).toBe('fullCooler');
    expect(appraiseLoot(loot({ cash: 90_000 }))).toBe('rich');
    // The cooler is what they can see from the deck.
    expect(appraiseLoot(loot({ cash: 90_000, coolerCount: 9, coolerLb: 300 }))).toBe('fullCooler');
    // A cap of 0 must not divide by zero into NaN.
    expect(appraiseLoot(loot({ coolerCap: 0, coolerCount: 1, coolerLb: 5 }))).toBe('someFish');
  });

  it('says the player\'s actual numbers back to them', () => {
    const rich = pirateScript(SEED, 3, loot({ cash: 123_456 }));
    expect(rich[2].text).toContain('$123,456');
    const haul = pirateScript(SEED, 3, loot({ coolerCount: 12, coolerLb: 287.4 }));
    expect(haul.map((x) => x.text).join(' ')).toMatch(/287|stuffed|haul/);
  });

  it('gives a different verdict to a rich player and a broke one', () => {
    for (let b = 0; b < 30; b++) {
      expect(pirateScript(SEED, b, loot({ cash: 90_000 }))[2].text).not.toBe(pirateScript(SEED, b, loot())[2].text);
    }
  });
});

describe('the script', () => {
  it('is ordered, has both speakers, and never prints an empty or undefined line', () => {
    for (let b = 0; b < 200; b++) {
      for (const l of [loot(), loot({ cash: 500 }), loot({ coolerCount: 3, coolerLb: 40 }), loot({ coolerCount: 9, coolerLb: 300 }), loot({ cash: 99_999 })]) {
        const s = pirateScript(SEED, b, l);
        expect(s.length).toBeGreaterThanOrEqual(6);
        for (let i = 1; i < s.length; i++) expect(s[i].at).toBeGreaterThan(s[i - 1].at);
        expect(new Set(s.map((x) => x.who))).toEqual(new Set(['captain', 'mate']));
        for (const beat of s) { expect(beat.text.length).toBeGreaterThan(8); expect(beat.text).not.toMatch(/undefined|NaN|\[object/); }
      }
    }
  });

  it('is deterministic per visit but varies between visits, so it does not go stale', () => {
    expect(pirateScript(SEED, 7, loot())).toEqual(pirateScript(SEED, 7, loot()));
    const distinct = new Set<string>();
    for (let b = 0; b < 60; b++) distinct.add(pirateScript(SEED, b, loot()).map((x) => x.text).join('|'));
    expect(distinct.size).toBeGreaterThan(30);
  });

  it('keeps every pool deep enough to be worth having', () => {
    expect(PIRATE_POOLS.hail).toBeGreaterThanOrEqual(4);
    expect(PIRATE_POOLS.aside).toBeGreaterThanOrEqual(8);
    expect(PIRATE_POOLS.farewell).toBeGreaterThanOrEqual(3);
    for (const n of Object.values(PIRATE_POOLS.verdict)) expect(n).toBeGreaterThanOrEqual(3);
  });

  it('never repeats the same aside twice in one visit', () => {
    for (let b = 0; b < 500; b++) {
      const s = pirateScript(SEED, b, loot());
      expect(s[4].text).not.toBe(s[5].text);
    }
  });
});
