/**
 * Buying things, owning things, and the one place the rest of the game asks "what does the player
 * have, and what does it change".
 *
 * ## Why a modifier bag
 *
 * Thirteen shops sell gear, consumables, buffs, cosmetics, sinks and services, and each kind is
 * consumed by a different system — the fight sim, the spear sim, the diver's breath model, the
 * bite timer, the renderer. If every one of those reached into the inventory and asked about item
 * ids, then adding an item would mean editing every consumer, and two systems would eventually
 * disagree about what "dive.fins" means.
 *
 * So nothing outside this module knows an item id. `modifiersFor(inv, nowS)` collapses everything
 * owned, carried and currently in effect into one flat bag of numbers (`Modifiers`), and each
 * system reads only the fields it cares about. Adding an item is then: list it in
 * content/venues.ts, map it here, done.
 *
 * ## Purity
 *
 * No three.js, no DOM, no `Date.now()` — time is passed in. docs/ARCHITECTURE.md puts anything
 * that can reach a leaderboard on the server, and "what tackle was this fish caught on" is
 * exactly that kind of claim, so the same functions have to run there. `buy` is a pure
 * `(state, …) -> result` and never mutates its inputs.
 *
 * Client-side ownership is NOT authoritative today — same status as the wallet in sim/economy.ts.
 * Said plainly here rather than implied.
 */
import { VENUES, type ShelfItem, type VenueId } from '../content/venues.js';

/** Everything the player owns, carries, or is currently under the influence of. */
export interface Inventory {
  /** Permanent gear, by `effect.key` (e.g. 'dive.fins'). */
  gear: readonly string[];
  /** Counted consumables, `effect.key` -> units remaining. */
  consumables: Readonly<Record<string, number>>;
  /** Timed buffs, `effect.key` -> simulated-seconds timestamp at which it expires. */
  buffs: Readonly<Record<string, number>>;
  /** Cosmetics owned, and the one worn per slot. */
  cosmetics: readonly string[];
  wearing: Readonly<Record<string, string>>;
}

export const emptyInventory = (): Inventory =>
  ({ gear: [], consumables: {}, buffs: {}, cosmetics: [], wearing: {} });

/**
 * What a BRAND-NEW player starts with, as opposed to `emptyInventory`, which means literally
 * nothing and is what tests and ports want.
 *
 * The speargun spends a shaft per shot, so a genuinely empty inventory means a new player's very
 * first shot is already the bent-spare fallback at 60% range. One pack is enough that the gun
 * works out of the box and few enough that the gun counter still has something to sell.
 *
 * The boat pistol (sim/handgun.ts) gets the same treatment for the same reason: 24 rounds is two
 * magazines, enough to find out what the mode is and to be a little disappointed when the second one
 * runs dry, which is the moment the gun counter's $75 box starts to make sense.
 */
export const startingInventory = (): Inventory =>
  ({ ...emptyInventory(), consumables: { 'spear.shafts': 3, 'handgun.ammo': 24 } });

/**
 * How long a bought buff lasts, in simulated seconds, by `effect.key`.
 *
 * Deliberately short relative to a session: a buff is a reason to stop in town on the way out, not
 * a thing you top up once and forget. A diner breakfast lasts a decent fishing session; a bar
 * round does not help you at all, which is the joke the venue copy already makes.
 */
export const BUFF_SECONDS: Readonly<Record<string, number>> = {
  'diner.coffee': 600,
  'diner.mahi': 900,
  'diner.pie': 480,
  'bar.wings': 600,
  'bar.beer': 420,
  'diner.breakfast': 900,
  'bar.shot': 240,
  'liquor.sixer': 300,
  'icecream.cone': 300,
  'conv.snacks': 420,
};

/** A purchase that cannot go through, and why — surfaced to the player verbatim. */
export type BuyFailure = 'not-for-sale' | 'cannot-afford' | 'already-owned' | 'no-such-item';

export interface BuyResult {
  ok: boolean;
  reason?: BuyFailure;
  /** Unchanged when `ok` is false. */
  inventory: Inventory;
  /** Dollars to deduct — 0 on failure. Applying it to the wallet is the caller's job, because the
   * wallet is the economy's state, not the shop's. */
  cost: number;
}

export function findItem(venueId: VenueId, itemId: string): ShelfItem | null {
  return VENUES[venueId]?.sells.find((s) => s.id === itemId) ?? null;
}

/** True when owning one of these a second time would do nothing — gear and cosmetics are permanent,
 * everything else stacks or re-times. */
const isUnique = (kind: string): boolean => kind === 'gear' || kind === 'cosmetic';

/**
 * Attempts a purchase. Pure: returns the new inventory and what it costs, and never touches the
 * wallet itself.
 *
 * `nowS` is simulated seconds, used only to time buffs. Buying the same buff twice extends from
 * *now* rather than stacking, which is the behaviour a player expects from a second coffee.
 */
export function buy(inv: Inventory, venueId: VenueId, itemId: string, cash: number, nowS: number): BuyResult {
  const it = findItem(venueId, itemId);
  if (!it) return { ok: false, reason: 'no-such-item', inventory: inv, cost: 0 };
  if (it.status !== 'live') return { ok: false, reason: 'not-for-sale', inventory: inv, cost: 0 };

  const { kind, key } = it.effect;
  if (isUnique(kind) && (inv.gear.includes(key) || inv.cosmetics.includes(key))) {
    return { ok: false, reason: 'already-owned', inventory: inv, cost: 0 };
  }
  if (cash < it.price) return { ok: false, reason: 'cannot-afford', inventory: inv, cost: 0 };

  // A pony bottle is live only while you hold an air fill (sim/dive-gear.ts), so a bottle bought
  // on its own is $4,500 of nothing until you notice a $12 item two rows down. That is a trap, not
  // a decision — it ships full.
  const freebies: Record<string, number> = key === 'dive.tank' ? { 'dive.fill': 1 } : {};

  const next: Inventory = {
    gear: kind === 'gear' ? [...inv.gear, key] : inv.gear,
    cosmetics: kind === 'cosmetic' ? [...inv.cosmetics, key] : inv.cosmetics,
    consumables: kind === 'consumable'
      ? { ...inv.consumables, [key]: (inv.consumables[key] ?? 0) + unitsPer(key) }
      : applyFreebies(inv.consumables, freebies),
    buffs: kind === 'buff'
      ? { ...inv.buffs, [key]: nowS + (BUFF_SECONDS[key] ?? 300) }
      : inv.buffs,
    // A cosmetic is worn the moment it is bought — nobody buys a shirt to carry it.
    wearing: kind === 'cosmetic' ? { ...inv.wearing, [slotOf(key)]: key } : inv.wearing,
  };
  return { ok: true, inventory: next, cost: it.price };
}

function applyFreebies(
  have: Readonly<Record<string, number>>, add: Record<string, number>,
): Readonly<Record<string, number>> {
  const keys = Object.keys(add);
  if (keys.length === 0) return have;
  const out = { ...have };
  for (const k of keys) out[k] = (out[k] ?? 0) + add[k];
  return out;
}

/** How many units one purchase of a consumable adds. Bait comes by the dozen; a bag of ice is one. */
function unitsPer(key: string): number {
  if (key === 'bait.shrimp') return 12;
  if (key === 'bait.ballyhoo') return 6;
  if (key === 'spear.shafts') return 3;
  if (key === 'handgun.ammo') return 50; // a box
  return 1;
}

/** Cosmetic slot from its key — 'cosmetic.shirt.hawaiian' -> 'shirt'. One worn item per slot. */
export function slotOf(key: string): string {
  const parts = key.split('.');
  return parts.length >= 2 ? parts[1] : key;
}

/** Spends one unit of a consumable. Returns the same reference when there is none left, so a
 * caller can cheaply tell whether it actually consumed anything. */
export function useOne(inv: Inventory, key: string): Inventory {
  const have = inv.consumables[key] ?? 0;
  if (have <= 0) return inv;
  return { ...inv, consumables: { ...inv.consumables, [key]: have - 1 } };
}

export const has = (inv: Inventory, gearKey: string): boolean => inv.gear.includes(gearKey);
export const countOf = (inv: Inventory, key: string): number => inv.consumables[key] ?? 0;
export const buffActive = (inv: Inventory, key: string, nowS: number): boolean => (inv.buffs[key] ?? 0) > nowS;

/** Drops expired buffs. Returns the same reference when nothing expired. */
export function pruneBuffs(inv: Inventory, nowS: number): Inventory {
  const live = Object.entries(inv.buffs).filter(([, exp]) => exp > nowS);
  if (live.length === Object.keys(inv.buffs).length) return inv;
  return { ...inv, buffs: Object.fromEntries(live) };
}

/* ------------------------------------------------------------------------------------------ *
 * The modifier bag — the only thing the rest of the game reads.
 * ------------------------------------------------------------------------------------------ */

/**
 * Everything the player's gear and state currently changes, as plain numbers.
 *
 * Multipliers are 1 = unchanged, so a system that forgets to apply one still behaves exactly as it
 * did before any of this existed. Additive fields are 0 = unchanged for the same reason.
 */
export interface Modifiers {
  /** Breath-hold duration multiplier (sim/diver.ts's AIR_MAX). The scuba shop's whole purpose. */
  breathMul: number;
  /** Diver swim-speed multiplier (long-blade fins). */
  swimMul: number;
  /** Extra underwater view distance, metres (wide mask). */
  viewBonusM: number;
  /** Extra speargun range, metres (long-range band gun). */
  spearRangeM: number;
  /** Speared-fish tether multiplier — lower is better, the fish runs less far (reel conversion). */
  spearTetherMul: number;
  /** Line/leader strength multiplier in the fight sim (heavy rod, lever reel, fluoro leader). */
  lineMul: number;
  /** Reel-in speed multiplier (lever-drag two-speed). */
  reelMul: number;
  /** Bite-wait multiplier — lower bites sooner (live bait). */
  biteMul: number;
  /** Odds multiplier for the rarer end of a zone table (rigged ballyhoo). */
  rareMul: number;
  /** Extra cooler capacity, lb (bagged ice). */
  coolerBonusLb: number;
  /** Steadiness: shrinks the strike window penalty and aim sway (coffee, a good breakfast). */
  steadyMul: number;
  /** Drunkenness, 0..1 — the opposite, and deliberately a liability (bar round, six-pack). */
  sway: number;
  /** Extra rounds in the boat pistol's magazine (extended magazine). sim/handgun.ts `magSizeFor`. */
  handgunMagBonus: number;
  /** Boat pistol spread multiplier — lower is tighter (red-dot sight). sim/handgun.ts `spreadFor`. */
  handgunSpreadMul: number;
}

export const NO_MODIFIERS: Modifiers = {
  breathMul: 1, swimMul: 1, viewBonusM: 0, spearRangeM: 0, spearTetherMul: 1,
  lineMul: 1, reelMul: 1, biteMul: 1, rareMul: 1, coolerBonusLb: 0, steadyMul: 1, sway: 0,
  handgunMagBonus: 0, handgunSpreadMul: 1,
};

/**
 * Collapses an inventory into its effects.
 *
 * Gear is permanent; buffs apply only while unexpired; consumables are NOT read here, because
 * spending one is an event (a cast, a shot) rather than a state — the system that spends it calls
 * `useOne` and applies its own effect at that moment.
 */
export function modifiersFor(inv: Inventory, nowS: number): Modifiers {
  const m = { ...NO_MODIFIERS };
  const g = (k: string): boolean => inv.gear.includes(k);

  // --- dive shop: the reason to go to town before a dive -------------------------------------
  if (g('dive.tank')) m.breathMul *= 2.2;        // the big one: a pony bottle on your back
  if (g('dive.wetsuit')) m.breathMul *= 1.18;    // warmth is air; shivering burns it
  if (g('dive.fins')) { m.swimMul *= 1.28; m.breathMul *= 1.08; } // less work per metre
  if (g('dive.mask')) m.viewBonusM += 6;

  // --- gun counter ---------------------------------------------------------------------------
  if (g('spear.long')) m.spearRangeM += 6;
  if (g('spear.reel')) m.spearTetherMul *= 0.6;
  // The boat pistol's two upgrades (sim/handgun.ts owns the numbers' meaning; the values live here
  // with every other gear effect so the gear screen and the inert-item test see them).
  if (g('handgun.extmag')) m.handgunMagBonus += 6;
  if (g('handgun.dot')) m.handgunSpreadMul *= 0.55;

  // --- tackle and pawn -----------------------------------------------------------------------
  if (g('rod.heavy')) { m.lineMul *= 1.35; m.reelMul *= 0.95; }
  if (g('rod.used')) m.lineMul *= 1.08;
  if (g('reel.lever')) { m.reelMul *= 1.3; m.lineMul *= 1.05; }

  // --- food, drink and the consequences ------------------------------------------------------
  if (buffActive(inv, 'diner.coffee', nowS)) m.steadyMul *= 1.25;
  if (buffActive(inv, 'diner.mahi', nowS)) { m.steadyMul *= 1.12; m.breathMul *= 1.05; }
  // A hot breakfast is the venue copy's own promise ("will one day steady your hands for the next
  // fight") — so it is the one food buff that reaches the fight itself, not just the strike window.
  if (buffActive(inv, 'diner.breakfast', nowS)) { m.steadyMul *= 1.18; m.lineMul *= 1.06; }
  if (buffActive(inv, 'diner.pie', nowS)) m.steadyMul *= 1.08;
  if (buffActive(inv, 'bar.wings', nowS)) m.steadyMul *= 1.06;
  if (buffActive(inv, 'icecream.cone', nowS)) m.steadyMul *= 1.05;
  if (buffActive(inv, 'conv.snacks', nowS)) m.steadyMul *= 1.05;
  // Drinking is a liability on purpose. The bar's own copy says a round does not help you.
  if (buffActive(inv, 'bar.shot', nowS)) m.sway = Math.min(1, m.sway + 0.35);
  if (buffActive(inv, 'bar.beer', nowS)) m.sway = Math.min(1, m.sway + 0.22);
  if (buffActive(inv, 'liquor.sixer', nowS)) m.sway = Math.min(1, m.sway + 0.5);
  if (m.sway > 0) m.steadyMul *= 1 - 0.4 * m.sway;

  return m;
}
