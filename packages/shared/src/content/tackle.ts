/**
 * Rod-and-reel tackle: the stats a fight (sim/fight.ts) actually reads, and the upgrade ladder the
 * boat economy (sim/economy.ts) can sell once somebody wires the shop.
 *
 * Why this exists: before it, the only "gear" in a fight was the drag knob, and `maxLine`/line
 * strength were fixed constants, so there was nothing for money to buy that made fishing better.
 * `lineLb` is the number that matters most: it sets the breaking point every fight is normalised
 * against, so the same 150 lb tarpon is a coin flip on 30 lb and a fair fight on 80 lb, while a
 * 3 lb trout is a formality on either. Rejected: a flat "+X% catch chance" stat, which would
 * have hidden the mechanism and let the server fudge outcomes instead of simulating them.
 *
 * SEAM (not wired, on purpose): `EconomyState` would gain `tackle: string` (owned ladder rung),
 * mirroring `boat`/`BOAT_PRICE`/`stepBuy`, and the client would pass `tackleById(economy.tackle)`
 * into `fightParamsFor`. Nothing here imports the economy; the economy may import this.
 */

export interface Tackle {
  id: string;
  name: string;
  /** Main line, rated breaking strength in lb. Every fight's tension is a fraction of this. */
  lineLb: number;
  /** Leader, lb. Sets how fast a long fight chafes through (heavier = slower fray). The weaker
   * of leader and line is where it breaks, so a heavy line on a light leader gains nothing. */
  leaderLb: number;
  /** Unloaded retrieve speed at the handle, m/s. Higher-geared reels gain line faster on a
   * resting fish; they do nothing against a running one (the drag decides that). */
  reelMs: number;
  /** Line capacity multiplier on the species' base `maxLine`: thin line packs more yardage. */
  spool: number;
}

/** Cheapest first. Light rungs are a sporting choice as much as a starter: a 12 lb outfit
 * makes a snook fun and a tarpon a gamble. Prices are on the scale of BOAT_PRICE (a first hull is
 * $8,000), pitched so the first heavy-line step lands well before the first boat. */
export const TACKLE: readonly Tackle[] = [
  { id: 'mono12', name: '12 lb mono light spin', lineLb: 12, leaderLb: 20, reelMs: 3.4, spool: 1.35 },
  { id: 'mono30', name: '30 lb mono conventional', lineLb: 30, leaderLb: 40, reelMs: 4.0, spool: 1 },
  { id: 'braid50', name: '50 lb braid, fluoro leader', lineLb: 50, leaderLb: 60, reelMs: 4.3, spool: 1.25 },
  { id: 'braid80', name: '80 lb braid, stand-up rig', lineLb: 80, leaderLb: 100, reelMs: 4.5, spool: 1.1 },
  { id: 'braid130', name: '130 lb big-game rig', lineLb: 130, leaderLb: 150, reelMs: 4.6, spool: 0.9 },
];

/**
 * What the player starts with.
 *
 * Was `mono30`, which hooks big fish and then loses them: measured over 2,500 hookups per zone
 * with an attentive angler, only 11% of 100 lb+ fish offshore were landed (3.8% in Hawk Channel,
 * 9.3% on the weedline), and the dominant loss was a pulled hook — the one failure the player can
 * do least about. "The rod hooks monsters you never see aboard" is not the same feature as
 * "bigger fish on the rod", and it is the one that shipped.
 *
 * The ladder above this still matters — braid80 roughly doubles trophy conversion again — but it
 * is not purchasable yet (no tackle shop is wired), so the starting rung is the *only* rung in
 * practice and has to be able to land the fish the tables now produce.
 */
export const STARTER_TACKLE = 'braid50';

export const TACKLE_PRICE: Readonly<Record<string, number>> = {
  mono12: 0, mono30: 0, braid50: 2_500, braid80: 12_000, braid130: 45_000,
};

export function tackleById(id: string | undefined | null): Tackle {
  return TACKLE.find((t) => t.id === id) ?? TACKLE.find((t) => t.id === STARTER_TACKLE)!;
}
