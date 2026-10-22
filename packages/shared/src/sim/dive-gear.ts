/**
 * What the player's dive gear does to ONE dive, and the rule that makes the pony bottle cost
 * something. Pure and three-free like the rest of sim/ — the same decision has to be reproducible
 * server-side later (bottom time is a claim, like tackle in sim/shop.ts).
 *
 * ## The tank rule (why it is shaped this way)
 *
 * `dive.tank` is a one-time $900 purchase that, taken alone, multiplies bottom time by 2.2. If
 * that were permanent the dive shop would be a single switch and `dive.fill` ($12) a dead item.
 * So the bottle is only LIVE while you hold a fill, and ONE FILL IS SPENT PER DIVE, charged the
 * first time you pass TANK_CHARGE_DEPTH (not on splashing in). Reasons for each choice:
 *  - Per dive, not per second of use: the player never watches a fuel counter or has the bottle
 *    go dry mid-dive. The air gauge already is the only thing they have to read.
 *  - Charged at 2 m, not on entry: hopping off the boat to cool off or snorkel the surface does
 *    not burn a $12 fill; only a real dive does.
 *  - No fill => the bottle is dead weight and its x2.2 is simply withheld; every other piece of
 *    gear (suit, fins, mask) keeps working. The dive then runs on the normal budget, so there is
 *    NO state in which a player can be underwater with less air than a gearless diver: the
 *    existing blackout -> "wake on the boat" recovery stays the only failure mode, and a broke
 *    player is never locked out of diving.
 *  - The budget is fixed at entry (`DiverState.airMax`), so spending the fill mid-dive cannot
 *    shrink the gauge under the player.
 * Price pressure: $12 per dive against a $900 bottle keeps it a real but small running cost.
 */
import type { Modifiers } from './shop.js';
import { airMaxFor } from './diver.js';

/** Must equal the dive.tank factor in sim/shop.ts modifiersFor (we cannot import it — it is inline
 * there). test/dive-gear.test.ts asserts they agree so a shop retune fails loudly. */
export const TANK_BREATH_MUL = 2.2;

/** Depth (m) at which the bottle's fill is spent. */
export const TANK_CHARGE_DEPTH = 2;

export interface DiveGear {
  mods: Pick<Modifiers, 'breathMul' | 'swimMul' | 'viewBonusM'>;
  /** Owns `dive.tank` (gear). */
  hasTank: boolean;
  /** Units of `dive.fill` in the inventory right now. */
  fills: number;
}

export interface DiveLoadout {
  airMax: number;
  swimMul: number;
  viewBonusM: number;
  /** The bottle is contributing this dive (owned AND a fill was in hand at entry). */
  tankLive: boolean;
}

export const NO_GEAR: DiveGear = { mods: { breathMul: 1, swimMul: 1, viewBonusM: 0 }, hasTank: false, fills: 0 };

/** Resolves gear into this dive's numbers. Call once at entry. */
export function loadoutFor(g: DiveGear): DiveLoadout {
  const tankLive = g.hasTank && g.fills >= 1;
  const breathMul = g.mods.breathMul / (g.hasTank && !tankLive ? TANK_BREATH_MUL : 1);
  return { airMax: airMaxFor(breathMul), swimMul: g.mods.swimMul, viewBonusM: g.mods.viewBonusM, tankLive };
}

/** True exactly once per dive: live bottle, not yet charged, deep enough. */
export function shouldChargeFill(l: DiveLoadout, depth: number, charged: boolean): boolean {
  return l.tankLive && !charged && depth >= TANK_CHARGE_DEPTH;
}
