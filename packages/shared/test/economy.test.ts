import { describe, expect, it } from 'vitest';
import { SPECIES } from '../src/content/species.js';
import { BOATS } from '../src/content/boats.js';
import {
  BOAT_ORDER, BOAT_PRICE, STARTER_BOAT, TIER_FLOOR, boatPrice, canAfford, createEconomy, deckWealth,
  fishValue, isTrophy, netWorth, nextBoat, payoutFor, sanitizeEconomy, stepBuy, stepCatch, stepSelect,
  wealthTier, type EconomyState,
} from '../src/sim/economy.js';

/** Weight `t` of the way through a species' range. */
const at = (key: string, t: number): number => SPECIES[key].min + (SPECIES[key].max - SPECIES[key].min) * t;
const withCash = (cash: number, over: Partial<EconomyState> = {}): EconomyState => ({ ...createEconomy(), cash, ...over });

/**
 * A "session" is ~15 minutes of fishing from the range the *current* hull opens up. These hauls are
 * deliberately modest (no trophy luck, mid-range fish) so the sessions-per-boat numbers below are
 * a pessimistic read of the curve, not a lucky one. Keyed by the hull you are saving up *from*.
 */
const HAUL: Record<string, Array<[string, number]>> = {
  // Grady: inshore flats + the patch reef.
  grady: [['snook', .4], ['redfish', .4], ['trout', .4], ['mangrove', .4], ['yellowtail', .4], ['mutton', .4], ['bonefish', .4], ['permit', .4], ['barracuda', .4], ['jackcrevalle', .4], ['hogfish', .4], ['tarpon', .4]],
  // Robalo is a flats boat: the same water, more of it, a few better fish.
  robalo: [['permit', .4], ['permit', .4], ['tarpon', .4], ['tarpon', .4], ['snook', .4], ['grouper', .4], ['mutton', .4], ['barracuda', .4], ['cobia', .4], ['kingfish', .4], ['mahi', .4], ['bonefish', .4]],
  // Contender reaches the reef edge and the first blue water.
  contender: [['mahi', .4], ['mahi', .4], ['kingfish', .4], ['kingfish', .4], ['cobia', .4], ['grouper', .4], ['blackfin', .4], ['wahoo', .4], ['amberjack', .4], ['sailfish', .4], ['tarpon', .4], ['permit', .4]],
  // Yellowfin goes offshore.
  yellowfin: [['yellowfin', .4], ['yellowfin', .4], ['wahoo', .4], ['wahoo', .4], ['mahi', .4], ['mahi', .4], ['sailfish', .4], ['amberjack', .4], ['blackfin', .4], ['grouper', .4], ['swordfish', .4], ['cobia', .4]],
  // Freeman and up fish the Gulf Stream for big game.
  freeman: [['yellowfin', .5], ['yellowfin', .5], ['wahoo', .5], ['sailfish', .5], ['marlin', .4], ['swordfish', .4], ['bluefin', .3], ['amberjack', .5], ['mahi', .5], ['goliath', .3], ['hammerhead', .3], ['bigeye', .5]],
  midnight: [['yellowfin', .5], ['marlin', .45], ['marlin', .45], ['bluefin', .4], ['swordfish', .45], ['blackmarlin', .4], ['bullshark', .45], ['hammerhead', .4], ['wahoo', .5], ['bigeye', .5], ['sailfish', .5], ['goliath', .4]],
  mti: [['marlin', .5], ['marlin', .5], ['bluefin', .5], ['bluefin', .45], ['blackmarlin', .5], ['swordfish', .5], ['hammerhead', .5], ['bullshark', .5], ['yellowfin', .6], ['bigeye', .6], ['goliath', .5], ['blackmarlin', .45]],
};
const sessionIncome = (from: string): number => HAUL[from].reduce((n, [k, t]) => n + fishValue(k, at(k, t)), 0);

describe('fish value', () => {
  it('pays more for a bigger fish of the same species, and a lot more at the top', () => {
    for (const key of Object.keys(SPECIES)) {
      const v = [0, .2, .4, .6, .8, 1].map((t) => fishValue(key, at(key, t)));
      for (let i = 1; i < v.length; i++) expect(v[i], `${key} step ${i}`).toBeGreaterThanOrEqual(v[i - 1]);
      expect(v[5], key).toBeGreaterThan(v[0] * 4);
    }
  });

  it('a trophy fish is a payday, a small grunt is not', () => {
    const trophyMarlin = fishValue('marlin', SPECIES.marlin.max);
    const grunt = fishValue('yellowtail', SPECIES.yellowtail.min);
    expect(trophyMarlin).toBeGreaterThan(4_000);
    expect(grunt).toBeLessThan(25);
    expect(trophyMarlin / grunt).toBeGreaterThan(200);
  });

  it('orders species sensibly: heavy game outpays reef snapper at the same size fraction', () => {
    const v = (k: string): number => fishValue(k, at(k, .5));
    expect(v('yellowtail')).toBeLessThan(v('mahi'));
    expect(v('mahi')).toBeLessThan(v('yellowfin'));
    expect(v('yellowfin')).toBeLessThan(v('marlin'));
    expect(v('trout')).toBeLessThan(v('tarpon'));
    expect(v('ladyfish')).toBeLessThan(v('permit'));
    expect(v('lionfish')).toBeLessThan(v('sailfish'));
  });

  it('flags only the top slice as a trophy and gives it a real step up', () => {
    expect(isTrophy('mahi', at('mahi', .5))).toBe(false);
    expect(isTrophy('mahi', at('mahi', .95))).toBe(true);
    const below = fishValue('mahi', at('mahi', .84)), above = fishValue('mahi', at('mahi', .86));
    expect(above / below).toBeGreaterThan(1.3);
  });

  it('is total: unknown species pay nothing and never throw; weights outside the range clamp', () => {
    expect(fishValue('not-a-fish', 10)).toBe(0);
    expect(fishValue('mahi', -5)).toBe(fishValue('mahi', SPECIES.mahi.min));
    expect(fishValue('mahi', 1e9)).toBe(fishValue('mahi', SPECIES.mahi.max));
    expect(Number.isInteger(fishValue('mahi', 23.7))).toBe(true);
  });
});

describe('boats', () => {
  it('every hull in the game is ordered and priced, with no strays', () => {
    expect([...BOAT_ORDER].sort()).toEqual(BOATS.map((b) => b.id).sort());
    expect(Object.keys(BOAT_PRICE).sort()).toEqual([...BOAT_ORDER].sort());
  });

  it('you start in the cheapest hull, for free, and it is the "Actively Sinking" one', () => {
    const s = createEconomy();
    expect(s.boat).toBe(STARTER_BOAT);
    expect(BOATS.find((b) => b.id === STARTER_BOAT)?.nickname).toBe('Actively Sinking');
    expect(boatPrice(STARTER_BOAT)).toBe(0);
    for (const id of BOAT_ORDER.slice(1)) expect(boatPrice(id)).toBeGreaterThan(0);
  });

  it('prices strictly increase down the unlock order', () => {
    for (let i = 1; i < BOAT_ORDER.length; i++) expect(boatPrice(BOAT_ORDER[i])).toBeGreaterThan(boatPrice(BOAT_ORDER[i - 1]));
  });

  it('the curve progresses: each next boat is roughly 3-6 reference sessions away, not 50', () => {
    for (let i = 0; i < BOAT_ORDER.length - 1; i++) {
      const from = BOAT_ORDER[i], to = BOAT_ORDER[i + 1];
      const sessions = boatPrice(to) / sessionIncome(from);
      expect(sessions, `${from} -> ${to}: ${sessions.toFixed(1)} sessions`).toBeGreaterThanOrEqual(3);
      expect(sessions, `${from} -> ${to}: ${sessions.toFixed(1)} sessions`).toBeLessThanOrEqual(6);
    }
  });

  it('playing it through actually unlocks the whole fleet, in order', () => {
    let s = createEconomy();
    let sessions = 0;
    while (nextBoat(s) && sessions < 200) {
      for (const [k, t] of HAUL[s.boat]) s = stepCatch(s, { key: k, weight: at(k, t) });
      sessions++;
      const nb = nextBoat(s);
      if (nb && canAfford(s, nb.id)) {
        const r = stepBuy(s, { boatId: nb.id });
        expect(r.ok).toBe(true);
        s = r.state;
      }
    }
    expect(s.owned).toEqual([...BOAT_ORDER]);
    expect(sessions).toBeLessThan(50);
  });
});

describe('buying', () => {
  it('cannot buy what you cannot afford, and nothing changes', () => {
    const s = withCash(boatPrice('robalo') - 1);
    const r = stepBuy(s, { boatId: 'robalo' });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.reason).toBe('insufficient-funds'); expect(r.short).toBe(1); }
    expect(r.state).toBe(s);
  });

  it('the price is the only gate: one dollar short fails, exact price works', () => {
    expect(stepBuy(withCash(boatPrice('nortech') - 1), { boatId: 'nortech' }).ok).toBe(false);
    expect(stepBuy(withCash(boatPrice('nortech')), { boatId: 'nortech' }).ok).toBe(true);
  });

  it('spends exactly the price, grants and selects the hull, and cash never goes negative', () => {
    const r = stepBuy(withCash(boatPrice('robalo') + 7), { boatId: 'robalo' });
    expect(r.ok).toBe(true);
    expect(r.state.cash).toBe(7);
    expect(r.state.owned).toContain('robalo');
    expect(r.state.boat).toBe('robalo');
  });

  it('refuses a hull you own (no double-charge) and a hull that does not exist', () => {
    const s = withCash(1e6);
    const a = stepBuy(s, { boatId: STARTER_BOAT });
    expect(a.ok).toBe(false);
    expect(a.state.cash).toBe(1e6);
    const b = stepBuy(s, { boatId: 'yacht' });
    expect(b.ok).toBe(false);
    expect(b.state).toBe(s);
    expect(canAfford(s, 'yacht')).toBe(false);
  });

  it('selects only owned hulls', () => {
    const s = createEconomy();
    expect(stepSelect(s, { boatId: 'nortech' })).toBe(s);
    const r = stepBuy(withCash(1e6), { boatId: 'contender' });
    expect(stepSelect(r.state, { boatId: STARTER_BOAT }).boat).toBe(STARTER_BOAT);
  });
});

describe('catching pays', () => {
  it('stepCatch is pure and adds exactly the payout', () => {
    const s = createEconomy();
    const w = at('mahi', .5);
    const next = stepCatch(s, { key: 'mahi', weight: w });
    expect(s.cash).toBe(0);
    expect(next.cash).toBe(fishValue('mahi', w));
    expect(next.earned).toBe(next.cash);
    expect(next.catches).toBe(1);
  });

  it('spending does not reduce lifetime earnings', () => {
    const r = stepBuy(withCash(5_000, { earned: 5_000 }), { boatId: 'robalo' });
    expect(r.state.earned).toBe(5_000);
  });

  it('reports a personal best only for a new best', () => {
    let s = createEconomy();
    expect(payoutFor(s, 'mahi', at('mahi', .5)).personalBest).toBe(true);
    s = stepCatch(s, { key: 'mahi', weight: at('mahi', .9) });
    expect(payoutFor(s, 'mahi', at('mahi', .5)).personalBest).toBe(false);
    expect(payoutFor(s, 'mahi', at('mahi', .9)).personalBest).toBe(false);
  });
});

describe('wealth tiers and the deck', () => {
  it('tiers rise monotonically with net worth', () => {
    let prev = 0;
    for (let w = 0; w <= 400_000; w += 500) { const t = wealthTier(w); expect(t).toBeGreaterThanOrEqual(prev); prev = t; }
    expect(wealthTier(0)).toBe(0);
    expect(wealthTier(TIER_FLOOR[TIER_FLOOR.length - 1])).toBe(TIER_FLOOR.length - 1);
  });

  it('buying a boat does not shrink the party: net worth counts hulls you own', () => {
    const s = withCash(boatPrice('contender'));
    const before = netWorth(s);
    const after = netWorth(stepBuy(s, { boatId: 'contender' }).state);
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it('more money means more people, and the hull length caps the crowd', () => {
    const counts = TIER_FLOOR.map((f) => deckWealth(f, 13).partyCount);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    expect(counts[counts.length - 1]).toBeGreaterThan(counts[0] * 4);
    expect(deckWealth(1e9, 7).partyCount).toBeLessThan(deckWealth(1e9, 13).partyCount);
    expect(deckWealth(0, 5).partyCount).toBeGreaterThanOrEqual(1);
  });

  it('underglow flair switches on above the bottom tiers only', () => {
    expect(deckWealth(0, 10).underglow).toBe(false);
    expect(deckWealth(1e6, 10).underglow).toBe(true);
  });
});

describe('sanitizeEconomy', () => {
  it('degrades garbage to a fresh start instead of throwing', () => {
    for (const bad of [null, undefined, 'x', 42, [], {}]) expect(sanitizeEconomy(bad)).toEqual(createEconomy());
  });
  it('drops negative/NaN cash, unknown hulls and an unowned selection', () => {
    const s = sanitizeEconomy({ cash: -50, earned: NaN, owned: ['robalo', 'yacht', 7], boat: 'nortech', catches: 3 });
    expect(s.cash).toBe(0);
    expect(s.earned).toBe(0);
    expect(s.owned).toEqual(['grady', 'robalo']);
    expect(s.boat).toBe(STARTER_BOAT);
    expect(s.catches).toBe(3);
  });
  it('round-trips a legal state', () => {
    const s = stepBuy(withCash(50_000, { earned: 60_000 }), { boatId: 'contender' }).state;
    expect(sanitizeEconomy(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});
