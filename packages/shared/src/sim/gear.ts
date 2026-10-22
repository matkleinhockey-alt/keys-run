/**
 * The spearfishing and rod-and-tackle half of "what the shop sells actually does something".
 *
 * sim/shop.ts collapses everything *owned* into a `Modifiers` bag, and deliberately leaves
 * consumables out of it: "spending one is an event (a cast, a shot) rather than a state". This
 * module is those events. Each function here is pure `(inventory, ...) -> (inventory', effect)`;
 * the client calls it at the moment the cast / shot / keep happens and writes the returned
 * inventory back through a `GearPort`. Nothing here knows an item id except through the
 * `effect.key`s named below, and none of them is read anywhere else.
 *
 * Owned gear (spear.long, spear.reel, rod.*, reel.lever) does not appear here at all: it already
 * arrives as `Modifiers` and is applied by `spearRangeFor` / `spearFightParamsFor` /
 * `fightParamsFor`. Only the things that get USED UP live in this file.
 *
 * Why a `GearPort` and not a direct inventory import: another agent owns the inventory's storage
 * and persistence. The client consumers take an OPTIONAL port; with none they behave exactly as
 * they did before the shop existed (unlimited shafts, no bait), so wiring the real inventory in is
 * passing one object, and nothing breaks while it is absent.
 */
import { countOf, modifiersFor, NO_MODIFIERS, useOne, type Inventory, type Modifiers } from './shop.js';

/** How a consumer reads and writes the player's inventory. `nowS` is simulated seconds. */
export interface GearPort {
  inventory(): Inventory;
  commit(next: Inventory): void;
  mods(nowS: number): Modifiers;
}

/** Builds a port over a single mutable inventory cell. For tests, harnesses and the client's
 * default wiring until the shop agent supplies the real one. */
export function createGearPort(initial: Inventory): GearPort & { current(): Inventory } {
  let inv = initial;
  return { inventory: () => inv, commit: (n) => { inv = n; }, mods: (nowS) => modifiersFor(inv, nowS), current: () => inv };
}

/* ------------------------------------------------------------------------------------------ *
 * Shafts
 * ------------------------------------------------------------------------------------------ */

/**
 * What happens when the player pulls the trigger with no bought shafts left.
 *
 * DECISION: the gun fires a free "bent spare" at `SPEAR_SPARE_RANGE_MUL` (60%) of its range, and
 * the UI says so. Alternatives rejected:
 *   - dead trigger: the player can be stranded with no way to catch anything from the water, and
 *     the failure is silent unless a toast explains it. The brief rules this out.
 *   - unlimited shafts: makes the $45 shaft pack inert, which is the exact "shop item that does
 *     nothing" bug this whole task exists to remove.
 *   - a recoverable shaft on a miss: needs shaft entities that persist in the world, a large
 *     system for a modest effect.
 * A spare at 60% range is the stock gun's old 11 m reach (18 * 0.6 = 10.8): usable at a fish that
 * is right there, hopeless at the edge, and clearly worse than paying for shafts. It costs
 * nothing, so nobody is ever locked out; and it is not free power, so shafts stay worth buying.
 */
export const SHAFT_KEY = 'spear.shafts';

export interface ShaftShot {
  inventory: Inventory;
  /** True when no bought shaft was available and the spare is being fired. */
  spare: boolean;
  /** Bought shafts left after this shot (0 while on the spare). */
  left: number;
}

/** Spends one shaft for a shot. Returns the same inventory reference when on the spare. */
export function takeShaft(inv: Inventory): ShaftShot {
  if (countOf(inv, SHAFT_KEY) <= 0) return { inventory: inv, spare: true, left: 0 };
  const next = useOne(inv, SHAFT_KEY);
  return { inventory: next, spare: false, left: countOf(next, SHAFT_KEY) };
}

/** The line the HUD shows about shafts, or null when there is nothing worth saying. Legible
 * running-out is part of the contract: the player is told at 1 left, at 0, and on the spare. */
export function shaftNotice(left: number, spare: boolean): string | null {
  if (spare) return 'Out of shafts — firing the bent spare (short range). Buy more at the gun counter.';
  if (left === 0) return 'Last shaft spent. Next shot is the bent spare (short range).';
  if (left === 1) return '1 shaft left.';
  return null;
}

/* ------------------------------------------------------------------------------------------ *
 * Bait and leader (spent at the cast / the hookup)
 * ------------------------------------------------------------------------------------------ */

export const SHRIMP_KEY = 'bait.shrimp';
export const BALLYHOO_KEY = 'bait.ballyhoo';
export const FLUORO_KEY = 'leader.fluoro';
export const ICE_KEY = 'cooler.ice';

/** Zones where a live shrimp is the right bait ("Bite rate up on the flats"). */
const SHRIMP_ZONES = new Set(['Creek', 'Bridge', 'Flats', 'Backcountry', 'Hawk Channel']);

/** Bite-wait multiplier of a shrimp on its home water vs anywhere else. 0.6 shortens the 4-10 s
 * wait to 2.4-6 s: a clear, felt gain over ~8 casts a session, without removing the wait. */
export const SHRIMP_BITE_MUL_HOME = 0.6;
export const SHRIMP_BITE_MUL_AWAY = 0.85;
/** Rare-end odds multiplier of a rigged ballyhoo offshore vs inshore (see fight.ts RARE_ODDS_MAX). */
export const BALLYHOO_RARE_MUL_HOME = 2;
export const BALLYHOO_RARE_MUL_AWAY = 1.25;

export type BaitKind = 'shrimp' | 'ballyhoo' | null;

export interface CastRig {
  inventory: Inventory;
  bait: BaitKind;
  /** Multiplies the bite wait (`F.biteT`). 1 = no bait. */
  biteMul: number;
  /** Passed to `pickSpecies` via `ChooseFishOpts.rareMul`. 1 = no bait. */
  rareMul: number;
}

/**
 * Spends one bait for a cast and reports what it does. One bait per cast: shrimp on the shallow
 * zones, ballyhoo on the deep ones; if the preferred one is gone the other is used at its
 * `AWAY` strength rather than leaving a stocked tackle box unused. The owned `mods` are folded in
 * so a future gear item with a bite/rare effect stacks on top.
 */
export function rigCast(inv: Inventory, zone: string, mods: Modifiers = NO_MODIFIERS): CastRig {
  const shallow = SHRIMP_ZONES.has(zone);
  const haveS = countOf(inv, SHRIMP_KEY) > 0, haveB = countOf(inv, BALLYHOO_KEY) > 0;
  const useShrimp = shallow ? haveS : !haveB && haveS;
  const useBally = !useShrimp && haveB;
  if (useShrimp) {
    return { inventory: useOne(inv, SHRIMP_KEY), bait: 'shrimp', rareMul: mods.rareMul, biteMul: mods.biteMul * (shallow ? SHRIMP_BITE_MUL_HOME : SHRIMP_BITE_MUL_AWAY) };
  }
  if (useBally) {
    return { inventory: useOne(inv, BALLYHOO_KEY), bait: 'ballyhoo', biteMul: mods.biteMul, rareMul: mods.rareMul * (shallow ? BALLYHOO_RARE_MUL_AWAY : BALLYHOO_RARE_MUL_HOME) };
  }
  return { inventory: inv, bait: null, biteMul: mods.biteMul, rareMul: mods.rareMul };
}

/** Spends one fluorocarbon leader for a hookup. Spent at the hookup, not the cast, because it is
 * the fight it protects: a cast that never gets a bite should not eat a $22 leader. */
export function rigLeader(inv: Inventory): { inventory: Inventory; fluoro: boolean } {
  if (countOf(inv, FLUORO_KEY) <= 0) return { inventory: inv, fluoro: false };
  return { inventory: useOne(inv, FLUORO_KEY), fluoro: true };
}

/* ------------------------------------------------------------------------------------------ *
 * Ice
 * ------------------------------------------------------------------------------------------ */

/** Cooler capacity a bag of ice adds for one load, lb (until the next weigh-in empties it). A
 * robalo's 150 lb cooler is the one that feels it (+40%); a freeman's 800 lb barely notices. */
export const ICE_BONUS_LB = 60;

export function coolerCapFor(baseLb: number, mods: Modifiers, iced: boolean): number {
  return baseLb + mods.coolerBonusLb + (iced ? ICE_BONUS_LB : 0);
}
