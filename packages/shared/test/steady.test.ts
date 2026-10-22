/**
 * What steady hands and a six-pack do (sim/steady.ts), and the buff timing/stacking rules the
 * client's expiry relies on (sim/shop.ts). The point of the first block is "a player can feel it":
 * every food must move the strike window by a real, non-trivial amount.
 */
import { describe, expect, it } from 'vitest';
import { buy, emptyInventory, modifiersFor, pruneBuffs, BUFF_SECONDS, type Inventory } from '../src/sim/shop.js';
import type { VenueId } from '../src/content/venues.js';
import {
  strikeWindowS, STRIKE_BASE_S, STRIKE_MIN_S, handWobble, tooDrunkToDive, liveBuffs, buffEdges,
  BUFF_LABELS, startToast, endToast,
} from '../src/sim/steady.js';

const take = (inv: Inventory, v: VenueId, id: string, now: number): Inventory => buy(inv, v, id, 1e6, now).inventory;
const fresh = (v: VenueId, id: string, now = 0): Inventory => take(emptyInventory(), v, id, now);
const win = (inv: Inventory, now: number): number => strikeWindowS(STRIKE_BASE_S, modifiersFor(inv, now));
const amp = (inv: Inventory, now: number): number => {
  const m = modifiersFor(inv, now);
  let mx = 0;
  for (let t = 0; t < 60; t += 0.05) { const w = handWobble(t, m); mx = Math.max(mx, Math.abs(w.pitch), Math.abs(w.yaw), Math.abs(w.roll)); }
  return mx;
};

describe('food steadies the hands where the player can feel it', () => {
  const foods: Array<[VenueId, string, number]> = [
    ['diner', 'coffee', 1.25], ['diner', 'mahi-sand', 1.12], ['diner', 'pie', 1.08],
    ['bar', 'wings', 1.06], ['icecream', 'cone', 1.05], ['convenience', 'snacks', 1.05],
  ];
  for (const [v, id, mul] of foods) {
    it(`${v}/${id} widens the strike window and shrinks the wobble`, () => {
      const inv = fresh(v, id);
      expect(win(inv, 1)).toBeCloseTo(STRIKE_BASE_S * mul, 5);
      expect(win(inv, 1)).toBeGreaterThan(STRIKE_BASE_S + 0.05);
      expect(amp(inv, 1)).toBeLessThan(amp(emptyInventory(), 1));
    });
  }

  it('is capped so a table full of food is a perk, not a cheat', () => {
    let inv = emptyInventory();
    for (const [v, id] of foods) inv = take(inv, v, id, 0);
    expect(win(inv, 1)).toBeLessThanOrEqual(STRIKE_BASE_S * 1.5 + 1e-9);
  });
});

describe('drink is a liability that never ends the session', () => {
  it('shrinks the window and makes the view roll', () => {
    const inv = fresh('liquor', 'sixer');
    expect(win(inv, 1)).toBeLessThan(STRIKE_BASE_S * 0.85);
    expect(amp(inv, 1)).toBeGreaterThan(amp(emptyInventory(), 1) * 5);
  });
  it('is still playable at the worst: window floor and a bounded roll', () => {
    let inv = fresh('liquor', 'sixer');
    inv = take(inv, 'bar', 'shot-key-lime', 0);
    expect(win(inv, 1)).toBeGreaterThanOrEqual(STRIKE_MIN_S);
    expect(amp(inv, 1)).toBeLessThan(0.15);
  });
  it('one drink may dive, two may not', () => {
    const six = fresh('liquor', 'sixer');
    expect(tooDrunkToDive(modifiersFor(six, 1))).toBe(false);
    expect(tooDrunkToDive(modifiersFor(take(six, 'bar', 'shot-key-lime', 0), 1))).toBe(true);
  });
  it('coffee takes the edge off a drink (but does not fix it)', () => {
    const drunk = fresh('liquor', 'sixer');
    const both = take(drunk, 'diner', 'coffee', 0);
    expect(win(both, 1)).toBeGreaterThan(win(drunk, 1));
    expect(win(both, 1)).toBeLessThan(STRIKE_BASE_S * 1.25);
  });
});

describe('expiry and stacking', () => {
  it('a buff is live strictly before its expiry and gone at it', () => {
    const inv = fresh('diner', 'coffee', 10);
    const exp = 10 + BUFF_SECONDS['diner.coffee'];
    expect(modifiersFor(inv, exp - 0.01).steadyMul).toBeCloseTo(1.25);
    expect(modifiersFor(inv, exp).steadyMul).toBe(1);
  });
  it('modifiersFor never reads a stale buff even before pruning', () => {
    const inv = fresh('diner', 'coffee', 0);
    expect(modifiersFor(inv, 99999).steadyMul).toBe(1);
  });
  it('pruneBuffs removes only expired buffs and keeps the reference when nothing expired', () => {
    let inv = fresh('liquor', 'sixer', 0);
    inv = take(inv, 'diner', 'coffee', 0);
    expect(pruneBuffs(inv, 1)).toBe(inv);
    const later = pruneBuffs(inv, BUFF_SECONDS['liquor.sixer'] + 1);
    expect(Object.keys(later.buffs)).toEqual(['diner.coffee']);
  });
  it('a second coffee re-times from now rather than stacking the multiplier', () => {
    let inv = fresh('diner', 'coffee', 0);
    inv = take(inv, 'diner', 'coffee', 300);
    expect(inv.buffs['diner.coffee']).toBe(300 + BUFF_SECONDS['diner.coffee']);
    expect(modifiersFor(inv, 301).steadyMul).toBeCloseTo(1.25);
  });
  it('different foods multiply; the drink penalty applies to the product', () => {
    let inv = fresh('diner', 'coffee');
    inv = take(inv, 'diner', 'pie', 0);
    expect(modifiersFor(inv, 1).steadyMul).toBeCloseTo(1.25 * 1.08);
  });
});

describe('buff bookkeeping for toasts and the strip', () => {
  it('lists live buffs soonest-first with whole seconds left', () => {
    let inv = fresh('diner', 'coffee', 0);
    inv = take(inv, 'liquor', 'sixer', 0);
    const l = liveBuffs(inv.buffs, 100);
    expect(l.map((b) => b.key)).toEqual(['liquor.sixer', 'diner.coffee']);
    expect(l[0].left).toBe(200);
  });
  it('edges report starts and ends', () => {
    expect(buffEdges(new Set(['a']), new Set(['a', 'b']))).toEqual({ started: ['b'], ended: [] });
    expect(buffEdges(new Set(['a', 'b']), new Set(['b']))).toEqual({ started: [], ended: ['a'] });
  });
  it('every timed buff has a label and toasts', () => {
    for (const k of Object.keys(BUFF_SECONDS)) {
      expect(BUFF_LABELS[k], k).toBeTruthy();
      expect(startToast(k)).toContain(BUFF_LABELS[k]);
      expect(endToast(k)).toContain(BUFF_LABELS[k]);
    }
  });
});
