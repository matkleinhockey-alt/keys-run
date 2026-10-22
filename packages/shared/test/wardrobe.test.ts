/**
 * Slot rules for cosmetics: one worn item per slot, swap, take off, nothing unowned, and -- the
 * important one -- no gameplay effect whatsoever.
 */
import { describe, expect, it } from 'vitest';
import { VENUES } from '../src/content/venues.js';
import { COSMETICS, COSMETIC_SLOTS } from '../src/content/cosmetics.js';
import { buy, emptyInventory, modifiersFor, NO_MODIFIERS, slotOf, type Inventory } from '../src/sim/shop.js';
import { wear, takeOff, ownedIn, outfitOf, outfitSignature } from '../src/sim/wardrobe.js';

const gifts = VENUES.gifts.sells;
const buyAll = (ids: readonly string[]): Inventory => {
  let inv = emptyInventory();
  for (const id of ids) inv = buy(inv, 'gifts', id, 1e6, 0).inventory;
  return inv;
};
const idOf = (key: string): string => gifts.find((s) => s.effect.key === key)!.id;

describe('the gift shop shelf', () => {
  it('sells at least a dozen cosmetics, across all four slots', () => {
    const slots = new Set(gifts.map((s) => slotOf(s.effect.key)));
    expect(gifts.length).toBeGreaterThanOrEqual(12);
    for (const s of COSMETIC_SLOTS) expect(slots.has(s)).toBe(true);
  });
  it('every item is a live cosmetic with a look, in the slot its key names', () => {
    for (const s of gifts) {
      expect(s.status).toBe('live');
      expect(s.effect.kind).toBe('cosmetic');
      const c = COSMETICS[s.effect.key];
      expect(c, s.effect.key).toBeDefined();
      expect(c.slot).toBe(slotOf(s.effect.key));
      expect(c.human || c.flag, s.effect.key).toBeTruthy();
    }
  });
  it('has no look in the table that the shop does not sell', () => {
    const sold = new Set(gifts.map((s) => s.effect.key));
    for (const k of Object.keys(COSMETICS)) expect(sold.has(k), k).toBe(true);
  });
});

describe('wearing, swapping, removing', () => {
  const inv0 = buyAll(['shirt-hawaiian', 'shirt-breton', 'cap-conch', 'glasses-neon']);
  it('buying wears it; a second item in the same slot replaces the first', () => {
    expect(inv0.wearing.shirt).toBe('cosmetic.shirt.breton');
    expect(inv0.wearing.cap).toBe('cosmetic.cap.conch');
    expect(Object.keys(inv0.wearing).sort()).toEqual(['cap', 'glasses', 'shirt']);
  });
  it('wear() swaps back to an owned item without losing the other', () => {
    const inv = wear(inv0, 'cosmetic.shirt.hawaiian');
    expect(inv.wearing.shirt).toBe('cosmetic.shirt.hawaiian');
    expect(inv.cosmetics).toEqual(inv0.cosmetics);
    expect(inv.wearing.cap).toBe('cosmetic.cap.conch');
  });
  it('wear() refuses unowned and unknown keys and returns the same reference', () => {
    expect(wear(inv0, 'cosmetic.shirt.luigi')).toBe(inv0);
    expect(wear(inv0, 'cosmetic.shirt.nope')).toBe(inv0);
    expect(wear(inv0, 'cosmetic.shirt.breton')).toBe(inv0);
  });
  it('takeOff() clears just that slot, and is a no-op when already bare', () => {
    const inv = takeOff(inv0, 'cap');
    expect(inv.wearing.cap).toBeUndefined();
    expect(inv.wearing.shirt).toBe('cosmetic.shirt.breton');
    expect(inv.cosmetics).toEqual(inv0.cosmetics); // still owned, just not on
    expect(takeOff(inv, 'cap')).toBe(inv);
    expect(wear(inv, 'cosmetic.cap.conch').wearing.cap).toBe('cosmetic.cap.conch');
  });
  it('does not mutate its input', () => {
    const before = JSON.stringify(inv0);
    wear(inv0, 'cosmetic.shirt.hawaiian'); takeOff(inv0, 'shirt');
    expect(JSON.stringify(inv0)).toBe(before);
  });
  it('ownedIn lists by slot in purchase order', () => {
    expect(ownedIn(inv0, 'shirt')).toEqual(['cosmetic.shirt.hawaiian', 'cosmetic.shirt.breton']);
    expect(ownedIn(inv0, 'flag')).toEqual([]);
  });
  it('outfitOf drops stale or unowned entries rather than dressing the player in them', () => {
    const bad: Inventory = { ...inv0, wearing: { shirt: 'cosmetic.shirt.luigi', cap: 'cosmetic.cap.conch', glasses: 'cosmetic.shirt.hawaiian', flag: 'gone' } };
    expect(outfitOf(bad)).toEqual({ cap: 'cosmetic.cap.conch' });
  });
  it('the outfit signature changes exactly when what is worn changes', () => {
    const a = outfitSignature(outfitOf(inv0));
    expect(outfitSignature(outfitOf(wear(inv0, 'cosmetic.shirt.hawaiian')))).not.toBe(a);
    expect(outfitSignature(outfitOf(inv0))).toBe(a);
    expect(outfitSignature({})).toBe('|||');
  });
});

describe('cosmetics are free of gameplay effect', () => {
  it('a player wearing everything has exactly the modifiers of a player wearing nothing', () => {
    const all = buyAll(gifts.map((s) => s.id));
    expect(Object.keys(all.wearing).length).toBe(COSMETIC_SLOTS.length);
    expect(modifiersFor(all, 0)).toEqual(NO_MODIFIERS);
    expect(modifiersFor(emptyInventory(), 0)).toEqual(NO_MODIFIERS);
  });
  it('can buy every item on the shelf once, and not twice', () => {
    const all = buyAll(gifts.map((s) => s.id));
    expect(all.cosmetics.length).toBe(gifts.length);
    expect(buy(all, 'gifts', idOf('cosmetic.cap.luigi'), 1e6, 0).reason).toBe('already-owned');
  });
});
