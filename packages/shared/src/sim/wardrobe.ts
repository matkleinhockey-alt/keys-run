/**
 * Putting cosmetics on and taking them off. Pure functions over the shared `Inventory`.
 *
 * `shop.ts` already auto-wears a cosmetic at the moment of purchase and keeps one worn key per slot in
 * `Inventory.wearing`. This is the other half: swap to something else you own, or take a slot off.
 * There is deliberately no state of its own here -- the gear/inventory screen presents the same
 * `Inventory.wearing`, so there is exactly one place that says what the player has on.
 *
 * "Taking off" a slot clears it, and the renderer then falls back to the everyday look the figure
 * starts with (plain white cap, plain dark shades, the default shirt). That is a choice: removing
 * the cap and shades outright would turn the player into a different-looking character rather than
 * someone who changed clothes, and every figure in the game shares the cap-and-shades baseline.
 *
 * Cosmetics never feed `modifiersFor` (see content/cosmetics.ts) -- nothing here changes gameplay.
 */
import { COSMETICS, COSMETIC_SLOTS, type CosmeticSlot } from '../content/cosmetics.js';
import { slotOf, type Inventory } from './shop.js';

/** Wear something you own. Returns the same reference when you do not own it, it is unknown, or it is
 * already on, so callers can cheaply tell whether anything changed. */
export function wear(inv: Inventory, key: string): Inventory {
  if (!inv.cosmetics.includes(key) || !(key in COSMETICS)) return inv;
  const slot = slotOf(key);
  if (inv.wearing[slot] === key) return inv;
  return { ...inv, wearing: { ...inv.wearing, [slot]: key } };
}

/** Take a slot off. Same reference when it was already bare. */
export function takeOff(inv: Inventory, slot: string): Inventory {
  if (!(slot in inv.wearing)) return inv;
  const rest = { ...inv.wearing };
  delete rest[slot];
  return { ...inv, wearing: rest };
}

/** Everything owned in a slot, in the order bought. */
export function ownedIn(inv: Inventory, slot: CosmeticSlot): string[] {
  return inv.cosmetics.filter((k) => COSMETICS[k]?.slot === slot);
}

/**
 * The outfit to actually draw: slot -> key, restricted to things that are owned and known. A saved or
 * foreign `wearing` can name something stale (an item later renamed, a hand-edited save), and the
 * renderer should dress the player in what is real rather than throw.
 */
export function outfitOf(inv: Inventory): Partial<Record<CosmeticSlot, string>> {
  const out: Partial<Record<CosmeticSlot, string>> = {};
  for (const slot of COSMETIC_SLOTS) {
    const key = inv.wearing[slot];
    if (key && inv.cosmetics.includes(key) && COSMETICS[key]?.slot === slot) out[slot] = key;
  }
  return out;
}

/** Stable text form of an outfit -- the renderer compares this to know whether to rebuild a figure. */
export const outfitSignature = (o: Partial<Record<CosmeticSlot, string>>): string =>
  COSMETIC_SLOTS.map((s) => o[s] ?? '').join('|');
