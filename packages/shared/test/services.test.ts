/**
 * The town's services: the scratch-off's payout distribution, and the motel's time/save transition.
 */
import { describe, expect, it } from 'vitest';
import { VENUES } from '../src/content/venues.js';
import { emptyInventory, type Inventory } from '../src/sim/shop.js';
import {
  SCRATCH_DENOM, SCRATCH_PRICE, SCRATCH_TABLE, SERVICE_KEYS, SLEEP_TIMES, canBuy, clubTier,
  createServices, createSleepTimeline, drawScratch, resolve, sanitizeServices, scratchOdds, sleepOff, washOff,
  type ServicesState,
} from '../src/sim/services.js';

const CTX = { isSunset: false };

describe('scratch-off distribution', () => {
  it('is a real gamble with a negative expected value, stated exactly', () => {
    const o = scratchOdds();
    expect(o.ev).toBeCloseTo(3.45, 10);
    expect(o.netEv).toBeLessThan(0);
    expect(o.returnPct).toBe(69);
    expect(o.winners).toBeLessThan(SCRATCH_DENOM);
    expect(o.oneIn).toBeCloseTo(1000 / 266, 6);
  });

  it('draws match the table over many seeded tickets (frequencies and realised return)', () => {
    const N = 60000;
    const counts = new Map<number, number>();
    let paid = 0;
    for (let n = 0; n < N; n++) {
      const c = drawScratch(12345, n);
      counts.set(c.prize, (counts.get(c.prize) ?? 0) + 1);
      paid += c.prize;
    }
    for (const [prize, w] of SCRATCH_TABLE) {
      const p = w / SCRATCH_DENOM;
      const sigma = Math.sqrt(N * p * (1 - p));
      // 5-sigma binomial band: never flakes on a fixed seed, still catches a wrong table.
      expect(Math.abs((counts.get(prize) ?? 0) - p * N), `prize ${prize}`).toBeLessThan(5 * sigma + 1);
    }
    const ret = paid / (N * SCRATCH_PRICE);
    expect(ret).toBeGreaterThan(0.6);
    expect(ret).toBeLessThan(0.78);
  });

  it('only ever pays prizes on the printed table', () => {
    const legal = new Set([0, ...SCRATCH_TABLE.map(([p]) => p)]);
    for (let n = 0; n < 3000; n++) expect(legal.has(drawScratch(7, n).prize)).toBe(true);
  });

  it('is deterministic: the same (seed, ticket) is the same card, a different seed is not', () => {
    expect(drawScratch(99, 4)).toEqual(drawScratch(99, 4));
    const same = Array.from({ length: 50 }, (_, n) => JSON.stringify(drawScratch(1, n)) === JSON.stringify(drawScratch(2, n)));
    expect(same.every(Boolean)).toBe(false);
  });

  it('cards read honestly: winners show exactly three of a kind, losers never do', () => {
    for (let n = 0; n < 5000; n++) {
      const c = drawScratch(31, n);
      const tally = new Map<string, number>();
      for (const s of c.cells) tally.set(s, (tally.get(s) ?? 0) + 1);
      const triples = [...tally.values()].filter((v) => v >= 3);
      expect(c.cells).toHaveLength(6);
      if (c.prize > 0) expect(triples, `ticket ${n}`).toEqual([3]);
      else expect(triples, `ticket ${n}`).toEqual([]);
    }
  });

  it('buying consumes the ticket number, so reloading cannot re-roll it', () => {
    const first = resolve(createServices(555), 'liquor.scratch', CTX);
    expect(first.state.tickets).toBe(1);
    expect(first.outcome.card).toEqual(drawScratch(555, 0));
    // "Reload": the persisted state is the one after the purchase; the next ticket is ticket 1.
    const reloaded = sanitizeServices(JSON.parse(JSON.stringify(first.state)), 0);
    const second = resolve(reloaded, 'liquor.scratch', CTX);
    expect(second.outcome.card).toEqual(drawScratch(555, 1));
    expect(second.state.scratchSpent).toBe(2 * SCRATCH_PRICE);
    expect(second.state.scratchWon).toBe(first.outcome.payout + second.outcome.payout);
  });

  it('the result card states the odds and the return', () => {
    const o = resolve(createServices(1), 'liquor.scratch', CTX).outcome;
    expect(o.lines.join(' ')).toMatch(/1 in 3\.8/);
    expect(o.lines.join(' ')).toMatch(/69 cents on the dollar/);
  });
});

describe('motel night', () => {
  it('refuses (and so never charges) when it is already sunset', () => {
    expect(canBuy(createServices(1), 'motel.night', { isSunset: true })).toMatch(/already evening/);
    expect(canBuy(createServices(1), 'motel.night', CTX)).toBeNull();
  });

  it('the sky only changes once the screen is fully black, exactly once', () => {
    const log: string[] = [];
    const tl = createSleepTimeline(() => log.push('black'));
    const dt = 0.05;
    let t = 0, maxBeforeBlack = 0, sawCard = false, done = false;
    while (!done && t < 20) {
      const r = tl.step(dt); t += dt;
      if (log.length === 0) maxBeforeBlack = Math.max(maxBeforeBlack, r.alpha);
      if (r.card) { sawCard = true; expect(r.alpha).toBe(1); expect(log).toEqual(['black']); }
      done = r.done;
    }
    expect(log).toEqual(['black']);
    expect(maxBeforeBlack).toBeLessThan(1);
    expect(sawCard).toBe(true);
    const total = SLEEP_TIMES.out + SLEEP_TIMES.hold + SLEEP_TIMES.in;
    expect(t).toBeGreaterThanOrEqual(total - 0.1);
    expect(t).toBeLessThan(total + 0.2);
  });

  it('commits the night to saved state at purchase, not at the end of the fade', () => {
    let s: ServicesState = createServices(3);
    s = resolve(s, 'club.cover', CTX).state;
    expect(s.admitted).toBe(true);
    const r = resolve(s, 'motel.night', CTX);
    expect(r.state.nights).toBe(1);
    expect(r.state.admitted).toBe(false); // a new evening: the list starts over
    expect(r.outcome.fx).toBe('sleep');
    expect(r.outcome.inventory).toBe('sleep');
    expect(r.outcome.lines.join(' ')).toMatch(/saved/i);
    expect(sanitizeServices(JSON.parse(JSON.stringify(r.state)), 0).nights).toBe(1);
  });

  it('a night clears timed buffs (and sobers you up); the input is not mutated', () => {
    const inv: Inventory = { ...emptyInventory(), buffs: { 'bar.shot': 999, 'diner.coffee': 999 } };
    const snap = JSON.stringify(inv);
    expect(sleepOff(inv).buffs).toEqual({});
    expect(JSON.stringify(inv)).toBe(snap);
    const e = emptyInventory();
    expect(sleepOff(e)).toBe(e);
  });

  it('cannot be chained: once slept it is sunset, so a second night is refused', () => {
    // The glue sets ctx.isSunset from the sky it just moved (and from "a sleep is in progress").
    const s = resolve(createServices(1), 'motel.night', CTX).state;
    expect(canBuy(s, 'motel.night', { isSunset: true })).not.toBeNull();
  });
});

describe('the other services', () => {
  it('club: tip needs cover, cover is not sold twice, a bottle includes the rope', () => {
    const s0 = createServices(2);
    expect(canBuy(s0, 'club.tip', CTX)).toMatch(/Cover first/);
    const inside = resolve(s0, 'club.cover', CTX).state;
    expect(canBuy(inside, 'club.cover', CTX)).not.toBeNull();
    expect(canBuy(inside, 'club.tip', CTX)).toBeNull();
    expect(resolve(s0, 'club.bottle', CTX).state.admitted).toBe(true);
    expect(resolve(inside, 'club.tip', CTX).outcome.fx).toBe('spotlight');
  });

  it('the bouncer remembers what you spend', () => {
    expect(clubTier(0)).toBe('stranger');
    expect(clubTier(20)).toBe('face');
    expect(clubTier(100)).toBe('regular');
    expect(clubTier(400)).toBe('vip');
  });

  it('fuel is declined without charge, and says why', () => {
    expect(canBuy(createServices(1), 'boat.fuel', CTX)).toMatch(/Keep your thirty bucks/);
  });

  it('wash: refuses when there is nothing to wash, and removes only the drink', () => {
    expect(canBuy(createServices(1), 'laundromat.wash', { ...CTX, tipsy: false })).not.toBeNull();
    expect(canBuy(createServices(1), 'laundromat.wash', { ...CTX, tipsy: true })).toBeNull();
    const inv: Inventory = { ...emptyInventory(), buffs: { 'bar.shot': 999, 'liquor.sixer': 999, 'diner.coffee': 999 } };
    expect(washOff(inv).buffs).toEqual({ 'diner.coffee': 999 });
  });

  it('every sink/service this module owns is handled, and the laundromat has stock', () => {
    const owned = ['motel', 'club', 'liquor', 'laundromat', 'convenience'] as const;
    for (const id of owned) {
      for (const it of VENUES[id].sells) {
        if (it.effect.kind !== 'sink' && it.effect.kind !== 'service' && it.effect.key !== 'boat.fuel') continue;
        expect(SERVICE_KEYS as readonly string[], `${id}/${it.id}`).toContain(it.effect.key);
      }
    }
    expect(VENUES.laundromat.sells.length).toBeGreaterThan(0);
  });

  it('sanitize clamps hostile saves', () => {
    const s = sanitizeServices({ tickets: -5, nights: 'x', clubSpent: 1e99, seed: 'nope', admitted: 1 }, 42);
    expect(s.tickets).toBe(0);
    expect(s.nights).toBe(0);
    expect(s.clubSpent).toBe(1e9);
    expect(s.seed).toBe(42);
    expect(s.admitted).toBe(false);
  });
});
