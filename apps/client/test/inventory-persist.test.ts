/**
 * The inventory blob is read from a player-editable localStorage string, so `sanitizeInventory`
 * must turn anything into a legal inventory — and must drop buffs whose expiry is already behind
 * the saved clock, or a reload would resurrect a coffee that ran out last week.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeInventory } from '../src/game/economy/inventory.js';

describe('sanitizeInventory', () => {
  it('survives garbage', () => {
    for (const bad of [null, 5, 'x', [], { inventory: 3 }]) {
      const s = sanitizeInventory(bad);
      expect(s.inventory.gear).toEqual([]);
      expect(s.clockS).toBe(0);
    }
  });
  it('keeps good entries, dedupes, drops junk and expired buffs', () => {
    const s = sanitizeInventory({
      clockS: 100,
      inventory: {
        gear: ['dive.fins', 'dive.fins', 7], cosmetics: ['cosmetic.shirt.hawaiian'],
        consumables: { 'bait.shrimp': 3, 'cooler.ice': 0, x: 'a' },
        buffs: { 'diner.coffee': 160, 'bar.shot': 50 }, wearing: { shirt: 'cosmetic.shirt.hawaiian', hat: 1 },
      },
    });
    expect(s.inventory.gear).toEqual(['dive.fins']);
    expect(s.inventory.consumables).toEqual({ 'bait.shrimp': 3 });
    expect(s.inventory.buffs).toEqual({ 'diner.coffee': 160 });
    expect(s.inventory.wearing).toEqual({ shirt: 'cosmetic.shirt.hawaiian' });
  });
});
