/**
 * The three money ladders together: hulls (sim/economy.ts BOAT_PRICE), tackle rungs
 * (content/tackle.ts TACKLE_PRICE) and the town's gear (content/venues.ts, effects from
 * sim/shop.ts modifiersFor). The properties here are the ones the prices were set to produce; if a
 * retune breaks one, either the retune or the claim is wrong, and the header of the price table says
 * which numbers to regenerate.
 *
 * MEASURED INPUTS (pinned). Produced by `node apps/client/test/playthrough-economy.mjs` (real shared
 * fight sim, fixed seed, 60 sessions of 30 simulated minutes per cell, 'angler' player, drag 3).
 * A test cannot run a 60-session Monte Carlo per CI run, so the table is pinned; re-run the harness
 * after any change to fight.ts / tackle stats / species / fishValue and update it. Dollars per 30
 * sim-minutes of rod time.
 */
import { describe, expect, it } from 'vitest';
import { BOAT_ORDER, BOAT_PRICE, TIER_FLOOR, wealthTier } from '../src/sim/economy.js';
import { TACKLE, TACKLE_PRICE, STARTER_TACKLE, tackleById } from '../src/content/tackle.js';
import { VENUES, type VenueId } from '../src/content/venues.js';
import { buy, emptyInventory, modifiersFor, type Inventory } from '../src/sim/shop.js';

type Zone = 'Hawk Channel' | 'Reef' | 'Offshore';
const MEASURED: Record<string, Record<Zone, number>> = {
  mono30: { 'Hawk Channel': 9_711, Reef: 10_756, Offshore: 14_830 },
  braid50: { 'Hawk Channel': 11_099, Reef: 12_499, Offshore: 21_043 },
  braid80: { 'Hawk Channel': 12_951, Reef: 13_747, Offshore: 29_353 },
  braid130: { 'Hawk Channel': 12_801, Reef: 14_360, Offshore: 35_240 },
  // starter braid50 + the town's rod/reel (modifiersFor lineMul / reelMul applied to the tackle)
  'braid50+heavy': { 'Hawk Channel': 11_246, Reef: 12_596, Offshore: 25_417 },
  'braid50+lever': { 'Hawk Channel': 12_512, Reef: 13_881, Offshore: 26_307 },
  'braid50+both': { 'Hawk Channel': 12_994, Reef: 13_651, Offshore: 29_821 },
};
/** 15 rod-minutes of a 30-minute table at 60% of the harness angler (see venues.ts PRICING). */
const SESSION = 0.3;
const perSession = (k: string, z: Zone): number => MEASURED[k][z] * SESSION;
const REEF = perSession('braid50', 'Reef'); // ~$3.75k: the first-session income
const OFFSHORE = perSession('braid50', 'Offshore'); // ~$6.3k

const price = (v: VenueId, id: string): number => VENUES[v].sells.find((s) => s.id === id)!.price;

/** Income per session for a greedy buyer by what they own. Offshore once confident (see timeline). */
function incomeFor(own: ReadonlySet<string>, offshore: boolean): number {
  const z: Zone = offshore ? 'Offshore' : 'Reef';
  const l = own.has('lever'), h = own.has('heavy');
  const rung = own.has('b130') ? 'braid130' : own.has('b80') ? 'braid80' : null;
  if (rung === 'braid130') return perSession('braid130', z) * (l || h ? 1.06 : 1);
  if (rung === 'braid80') return perSession('braid80', z) * (l || h ? 1.15 : 1);
  return perSession(l && h ? 'braid50+both' : l ? 'braid50+lever' : h ? 'braid50+heavy' : 'braid50', z);
}

/** The shop list in the order a competent player buys it; every step is "wait until you can afford it". */
const BUY_ORDER: Array<[string, number]> = [
  ['mask', price('dive', 'mask-wide')], ['lever', price('tackle', 'reel-lever')], ['fins', price('dive', 'fins-long')],
  ['heavy', price('tackle', 'rod-heavy')], ['pony', price('dive', 'tank-pony')], ['robalo', BOAT_PRICE.robalo],
  ['wetsuit', price('dive', 'wetsuit')], ['b80', TACKLE_PRICE.braid80], ['long', price('guns', 'spear-long')],
  ['reel', price('guns', 'spear-reel')], ['contender', BOAT_PRICE.contender], ['b130', TACKLE_PRICE.braid130],
  ['yellowfin', BOAT_PRICE.yellowfin], ['freeman', BOAT_PRICE.freeman], ['midnight', BOAT_PRICE.midnight],
  ['mti', BOAT_PRICE.mti], ['nortech', BOAT_PRICE.nortech],
];
function timeline(): Record<string, number> {
  let cash = 0, S = 0; const own = new Set<string>(); const at: Record<string, number> = {};
  for (const [item, cost] of BUY_ORDER) {
    while (cash < cost) {
      cash += incomeFor(own, own.has('lever') || own.has('heavy') || S >= 2.5);
      S++;
      if (S > 500) throw new Error('unreachable');
    }
    cash -= cost; own.add(item); at[item] = S;
  }
  return at;
}

const ownAll = (...ids: Array<[VenueId, string]>): Inventory => {
  let inv = emptyInventory();
  for (const [v, id] of ids) inv = buy(inv, v, id, 1e9, 0).inventory;
  return inv;
};

describe('hull ladder, measured against the shelf it competes with', () => {
  const at = timeline();

  it('the first hull lands in session 3-6, behind the cheap kit and the first big gear buy', () => {
    expect(at.robalo).toBeGreaterThanOrEqual(3);
    expect(at.robalo).toBeLessThanOrEqual(6);
    expect(at.mask).toBeLessThanOrEqual(1);
    expect(at.lever).toBeGreaterThan(at.mask);
  });

  it('every later hull is 2-8 sessions after the previous one, interleaved with gear', () => {
    const hulls = BOAT_ORDER.slice(1);
    for (let i = 1; i < hulls.length; i++) {
      const gap = at[hulls[i]] - at[hulls[i - 1]];
      expect(gap, `${hulls[i - 1]} -> ${hulls[i]}: ${gap} sessions`).toBeGreaterThanOrEqual(2);
      expect(gap, `${hulls[i - 1]} -> ${hulls[i]}: ${gap} sessions`).toBeLessThanOrEqual(8);
    }
  });

  it('the whole fleet plus every shelf item is on the order of 30-40 sessions', () => {
    expect(at.nortech).toBeGreaterThanOrEqual(28);
    expect(at.nortech).toBeLessThanOrEqual(42);
  });

  it('hull price steps never more than halve (the ladder is convex, no cheap late hull)', () => {
    for (let i = 2; i < BOAT_ORDER.length; i++) {
      const step = BOAT_PRICE[BOAT_ORDER[i]] - BOAT_PRICE[BOAT_ORDER[i - 1]];
      const prev = BOAT_PRICE[BOAT_ORDER[i - 1]] - BOAT_PRICE[BOAT_ORDER[i - 2]];
      expect(step, BOAT_ORDER[i]).toBeGreaterThan(prev * 0.5);
    }
  });

  it('wealth tiers: the first hull is already a tier up, and the last tier is reached by the 7th hull', () => {
    let worth = 0;
    const tiers = BOAT_ORDER.map((id) => wealthTier((worth += BOAT_PRICE[id])));
    expect(tiers[1]).toBeGreaterThanOrEqual(2);
    expect(tiers[6]).toBe(TIER_FLOOR.length - 1);
  });
});

describe('the early game: something to buy, and a real choice', () => {
  it('the cheap dive kit (mask+fins+wetsuit) is affordable inside the first session', () => {
    const kit = price('dive', 'mask-wide') + price('dive', 'fins-long') + price('dive', 'wetsuit');
    expect(kit).toBeLessThanOrEqual(REEF * 0.6);
    expect(price('dive', 'mask-wide')).toBeLessThanOrEqual(REEF / 10); // ~1.5 minutes: the first purchase
  });

  it('nothing with an effect is pocket change: every gear item but the used rod costs >= 1 effective minute', () => {
    const minute = REEF / 15;
    for (const v of Object.values(VENUES)) for (const s of v.sells) {
      if (s.effect.kind !== 'gear' || s.id === 'used-rod') continue;
      expect(s.price, `${v.id}/${s.id}`).toBeGreaterThanOrEqual(minute);
    }
  });

  it('the fork: pony bottle, lever reel and the first hull cannot all be had in the first hour (2 sessions)', () => {
    const hour = 2 * REEF;
    const pony = price('dive', 'tank-pony'), lever = price('tackle', 'reel-lever');
    expect(pony).toBeLessThanOrEqual(hour);
    expect(lever).toBeLessThanOrEqual(hour);
    expect(pony + lever).toBeGreaterThan(hour);
    expect(BOAT_PRICE.robalo).toBeGreaterThan(hour);
    // ...and neither is free: each is at least one full session of inshore income
    expect(pony).toBeGreaterThanOrEqual(REEF);
    expect(lever).toBeGreaterThanOrEqual(REEF);
  });

  it('the first hull is NOT cheaper than the big gear it competes with, and is within 2.5x of it', () => {
    const big = Math.max(price('dive', 'tank-pony'), price('tackle', 'reel-lever'));
    expect(BOAT_PRICE.robalo).toBeGreaterThan(big);
    expect(BOAT_PRICE.robalo).toBeLessThan(big * 2.5);
  });
});

describe('prices track what the item does (modifiersFor is the ground truth)', () => {
  it('dive gear is ordered by effect: bottle >> wetsuit > fins > mask', () => {
    const m = (id: string) => modifiersFor(ownAll(['dive', id]), 0);
    expect(m('tank-pony').breathMul).toBeGreaterThan(2);
    expect(m('wetsuit').breathMul).toBeGreaterThan(m('fins-long').breathMul);
    const [tank, suit, fins, mask] = ['tank-pony', 'wetsuit', 'fins-long', 'mask-wide'].map((id) => price('dive', id));
    expect(tank).toBeGreaterThan(suit * 4);
    expect(suit).toBeGreaterThan(fins);
    expect(fins).toBeGreaterThan(mask);
  });

  it('a gear item that measures a bigger lift costs more (lever > heavy rod > used rod)', () => {
    expect(price('tackle', 'reel-lever')).toBeGreaterThan(price('tackle', 'rod-heavy'));
    expect(price('tackle', 'rod-heavy')).toBeGreaterThan(price('pawn', 'used-rod') * 10);
  });

  it('rod and reel pay back in 1.5-6 offshore sessions on the measured lift', () => {
    const base = perSession('braid50', 'Offshore');
    for (const [k, p] of [['braid50+heavy', price('tackle', 'rod-heavy')], ['braid50+lever', price('tackle', 'reel-lever')]] as const) {
      const payback = p / (perSession(k, 'Offshore') - base);
      expect(payback, k).toBeGreaterThanOrEqual(1.5);
      expect(payback, k).toBeLessThanOrEqual(6);
    }
  });

  it('sinks cost a visible slice of a session', () => {
    expect(price('club', 'bottle')).toBeGreaterThan(REEF / 2);
    expect(price('bar', 'round')).toBeGreaterThanOrEqual(REEF / 20);
  });
});

describe('tackle rungs: coherent with each other and with the town rod/reel', () => {
  const rungs = TACKLE.filter((t) => TACKLE_PRICE[t.id] > 0);
  const eff = (t: { lineLb: number; leaderLb: number }, lineMul: number): number => Math.min(t.lineLb, t.leaderLb) * lineMul;
  const lineMulOf = (...ids: Array<[VenueId, string]>): number => modifiersFor(ownAll(...ids), 0).lineMul;
  const HEAVY: [VenueId, string] = ['tackle', 'rod-heavy'], LEVER: [VenueId, string] = ['tackle', 'reel-lever'], USED: [VenueId, string] = ['pawn', 'used-rod'];

  it('every rung is priced, the starter is free, and price rises with line strength', () => {
    expect(Object.keys(TACKLE_PRICE).sort()).toEqual(TACKLE.map((t) => t.id).sort());
    expect(TACKLE_PRICE[STARTER_TACKLE]).toBe(0);
    for (let i = 1; i < TACKLE.length; i++) {
      expect(TACKLE[i].lineLb).toBeGreaterThan(TACKLE[i - 1].lineLb);
      expect(TACKLE_PRICE[TACKLE[i].id]).toBeGreaterThanOrEqual(TACKLE_PRICE[TACKLE[i - 1].id]);
    }
  });

  it('no purchasable rung is strictly dominated: no cheaper rung-plus-town-gear combo has as much line', () => {
    // Every (rung, subset of rod/reel/used) combo, priced from the shelves, powered from modifiersFor.
    const subsets: Array<Array<[VenueId, string]>> = [[], [HEAVY], [LEVER], [USED], [HEAVY, LEVER], [HEAVY, USED], [LEVER, USED], [HEAVY, LEVER, USED]];
    const cost = (s: Array<[VenueId, string]>): number => s.reduce((n, [v, id]) => n + price(v, id), 0);
    const combos = TACKLE.flatMap((t) => subsets.map((s) => ({ id: t.id, s, price: TACKLE_PRICE[t.id] + cost(s), power: eff(t, s.length ? lineMulOf(...s) : 1) })));
    for (const r of rungs) {
      const power = eff(r, 1);
      const rivals = combos.filter((c) => !(c.id === r.id && c.s.length === 0) && c.price <= TACKLE_PRICE[r.id] && c.power >= power);
      expect(rivals.map((c) => `${c.id}+${c.s.length}`), `${r.id} dominated`).toEqual([]);
    }
  });

  it('heavy rod + lever reel and the braid80 rung are the same money for the same lift (within 20%)', () => {
    const route = price('tackle', 'rod-heavy') + price('tackle', 'reel-lever');
    expect(TACKLE_PRICE.braid80 / route).toBeGreaterThan(0.8);
    expect(TACKLE_PRICE.braid80 / route).toBeLessThan(1.2);
    const lift = (k: string): number => MEASURED[k].Offshore / MEASURED.braid50.Offshore;
    expect(lift('braid80') / lift('braid50+both')).toBeGreaterThan(0.9);
    expect(lift('braid80') / lift('braid50+both')).toBeLessThan(1.1);
  });

  it('marginal dollars per added pound of line rise at every step: heavy rod < braid80 < braid130', () => {
    const starter = tackleById(STARTER_TACKLE);
    const heavyLb = eff(starter, lineMulOf(HEAVY)) - eff(starter, 1);
    const perLb = [
      price('tackle', 'rod-heavy') / heavyLb,
      TACKLE_PRICE.braid80 / (eff(tackleById('braid80'), 1) - eff(starter, 1)),
      (TACKLE_PRICE.braid130 - TACKLE_PRICE.braid80) / (eff(tackleById('braid130'), 1) - eff(tackleById('braid80'), 1)),
    ];
    expect(perLb[0]).toBeLessThan(perLb[1]);
    expect(perLb[1]).toBeLessThan(perLb[2]);
  });

  it('the town rod/reel STACK on a rung (braid80+both lands between braid80 and braid130)', () => {
    const stacked = eff(tackleById('braid80'), lineMulOf(HEAVY, LEVER));
    expect(stacked).toBeGreaterThan(80);
    expect(stacked).toBeLessThan(130 * 1.2);
  });

  it('the trophy rung is dear enough to be a goal: braid130 sits between the first two blue-water hulls', () => {
    expect(TACKLE_PRICE.braid130).toBeGreaterThan(BOAT_PRICE.contender);
    expect(TACKLE_PRICE.braid130).toBeLessThan(BOAT_PRICE.freeman);
  });

  it('measured: each rung earns more offshore than the one below, with diminishing inshore returns', () => {
    const order = ['mono30', 'braid50', 'braid80', 'braid130'];
    for (let i = 1; i < order.length; i++) expect(MEASURED[order[i]].Offshore).toBeGreaterThan(MEASURED[order[i - 1]].Offshore);
    // inshore the top rung is no longer a big deal (the fish are small); offshore it still is
    expect(MEASURED.braid130['Hawk Channel'] / MEASURED.braid80['Hawk Channel']).toBeLessThan(1.05);
    expect(MEASURED.braid130.Offshore / MEASURED.braid80.Offshore).toBeGreaterThan(1.15);
    expect(OFFSHORE).toBeGreaterThan(REEF);
  });
});
