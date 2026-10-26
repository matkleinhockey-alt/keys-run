/**
 * Trolling: lines out behind a boat under way, lures swimming, and a strike that arrives without
 * warning and at full speed.
 *
 * Pure, like every other `sim/**` module — the client owns the outriggers, the sound and the
 * camera shake, and this owns the rules: how fast you have to be going, how long until something
 * eats, and what eats it.
 *
 * ## Why trolling is not casting with the engine on
 *
 * Rod fishing in this game is a cast, a wait, a nibble and a strike window you have to hit, and
 * `game/fishing/update.ts` reels the line in above 3.2 m/s on purpose — a bait sat under a float
 * does not work from a moving boat. Trolling inverts all of it: the boat MUST be moving, there is
 * no cast and no nibble, and the fish hooks itself against the drag at seven knots. The player's
 * skill moves from timing a strike to choosing where to drag the lures and what to do once
 * something is on. So this is its own small sim rather than a flag on the other one.
 *
 * ## The speed window
 *
 * A lure swims properly in a band and is useless outside it: too slow and it sinks and wobbles,
 * too fast and it blows out of the water and skips. Real offshore trolling is 5-9 knots and that
 * is what `TROLL_SPEED_MIN/MAX` are. Being outside the band does not stop the lines working, it
 * makes them much worse, which is a thing the player can feel and correct rather than a refusal
 * they have to decode.
 */

/** m/s. 5 knots: below this the spread sinks and stops swimming. */
export const TROLL_SPEED_MIN = 2.6;
/** m/s. 9 knots: above this the lures blow out and skip across the surface. */
export const TROLL_SPEED_MAX = 4.6;
/** m/s. ~7 knots, the middle of the band — what the autopilot holds. */
export const TROLL_SPEED_TARGET = 3.6;

/** Seconds between strikes at the best speed over ordinary water, before the zone multiplier. */
export const TROLL_BASE_GAP_S = 95;
/**
 * Never less than this many SECONDS between strikes, however good the water.
 *
 * Seconds, not credit. The first version made it a floor on the credit budget, which rich water
 * simply spends faster — at richness 50 the "22 second" floor was gone in 0.44 s and the rod
 * went off twice in a second. A hookup every few seconds is a slot machine, not fishing, and the
 * only thing that actually bounds it is the clock.
 */
export const TROLL_MIN_GAP_S = 22;

/**
 * How well the spread is fishing at `speed`, 0..1.
 *
 * Peaks at `TROLL_SPEED_TARGET` and falls to zero at the edges of the band — a cosine lobe rather
 * than a plateau with cliffs, so the player feels themselves getting warmer as they trim the
 * throttle instead of stepping over an invisible line. Outside the band it is 0: the lures are
 * not fishing, and nothing will eat them.
 */
export function trollQuality(speed: number): number {
  const s = Math.abs(speed);
  if (s <= TROLL_SPEED_MIN || s >= TROLL_SPEED_MAX) return 0;
  const half = (TROLL_SPEED_MAX - TROLL_SPEED_MIN) / 2;
  const off = (s - (TROLL_SPEED_MIN + half)) / half;      // -1..1 across the band
  return Math.max(0, Math.cos(off * (Math.PI / 2)));
}

export interface TrollState {
  /** Lines are out. */
  out: boolean;
  /** Seconds of fishing credit still to accumulate before the next strike. Counts DOWN by
   * `quality * dt`, so a badly-trimmed boat takes proportionally longer rather than never. */
  untilStrike: number;
  /** Seconds the lines have been out this set, for the UI and for `stepTroll`'s own warm-up. */
  soak: number;
  /** Seconds since the last strike — the thing `TROLL_MIN_GAP_S` actually bounds. */
  sinceStrike: number;
}

export interface TrollInput {
  /** Boat speed over the ground, m/s. */
  speed: number;
  /**
   * How rich this water is, as a multiplier on the strike rate. The caller supplies it from
   * whatever it already knows about the spot — a weedline, a colour change, a hump. 1 is open
   * water. This module deliberately does not reach for the zone tables itself: it would have to
   * know about the whole content layer to do it, and the caller already has the answer.
   */
  richness: number;
}

export function createTrollState(): TrollState {
  return { out: false, untilStrike: TROLL_BASE_GAP_S, soak: 0, sinceStrike: TROLL_MIN_GAP_S };
}

/** Lines out: resets the clock so a fresh set does not inherit the last one's near-miss. */
export function setLinesOut(state: TrollState, out: boolean, rng: () => number = Math.random): TrollState {
  if (out === state.out) return state;
  return out
    ? { out: true, untilStrike: TROLL_BASE_GAP_S * (0.55 + rng() * 0.9), soak: 0, sinceStrike: TROLL_MIN_GAP_S }
    : { out: false, untilStrike: TROLL_BASE_GAP_S, soak: 0, sinceStrike: TROLL_MIN_GAP_S };
}

export interface TrollStep {
  state: TrollState;
  /** A fish has eaten. The caller turns this into a hookup. */
  strike: boolean;
  /** 0..1 — how well the spread was fishing at the moment of the strike. Carried out so the
   * caller can bias the species roll toward the better fish when the boat was trimmed right. */
  quality: number;
}

/**
 * One tick. House shape: `step*(state, input, dt) => state`.
 *
 * The clock is spent in PROPORTION to how well the lures are swimming, which is what makes the
 * speed window a thing you manage rather than a gate you pass once. At dead-on seven knots over
 * rich water a strike is a minute or two away; at the ragged edge of the band it is many times
 * that; outside it, never.
 */
export function stepTroll(state: TrollState, input: TrollInput, dt: number, rng: () => number = Math.random): TrollStep {
  if (!state.out || dt <= 0) return { state, strike: false, quality: 0 };
  const q = trollQuality(input.speed);
  const soak = state.soak + dt;
  const sinceStrike = state.sinceStrike + dt;
  if (q <= 0) return { state: { ...state, soak, sinceStrike }, strike: false, quality: 0 };
  const credit = q * Math.max(0.1, input.richness) * dt;
  const left = state.untilStrike - credit;
  // The budget can be spent and the strike still held back: the clock is the real floor.
  if (left > 0 || sinceStrike < TROLL_MIN_GAP_S) {
    return { state: { ...state, untilStrike: Math.max(0, left), soak, sinceStrike }, strike: false, quality: q };
  }
  return {
    state: { out: true, untilStrike: TROLL_BASE_GAP_S * (0.55 + rng() * 0.9), soak, sinceStrike: 0 },
    strike: true,
    quality: q,
  };
}

/**
 * What a trolled lure is most likely to provoke.
 *
 * This used to be an ordered list that doubled as a filter: a species not on it could never take
 * a trolled lure at all, so a grouper or a snook simply did not exist to the mechanic, and the
 * order put sailfish and mahi ahead of every tuna. Anything in the water can eat a lure dragged
 * past it — that is the whole point of dragging one — so the list is a set of WEIGHTS now, and
 * anything not named still hits at the baseline.
 *
 * The weighting is what the mechanic is for: the tunas, the billfish and wahoo are what you set
 * a spread to catch, so they dominate. Behind them are the other fast pelagics that genuinely
 * take a lure. Everything else is possible and uncommon, which is honest — people do catch odd
 * things trolling.
 */
export const TROLL_WEIGHTS: Readonly<Record<string, number>> = {
  // What the spread is set for.
  wahoo: 12, yellowfin: 12, bluefin: 12, bigeye: 12,
  blackfin: 10, albacore: 10, marlin: 10, blackmarlin: 10,
  sailfish: 9, swordfish: 8, skipjack: 8,
  // Fast and lure-hungry, but not why you put the riggers out.
  mahi: 6, kingfish: 5, mako: 3, barracuda: 3, cero: 3, spanishmack: 3,
  amberjack: 2, jackcrevalle: 2, tarpon: 2,
};

/** Anything with no entry above — it can still hit, it is just not what you were fishing for. */
export const TROLL_BASE_WEIGHT = 1;

/** The fish the mechanic exists for, for anything that wants to name them. */
export const TROLL_PREFERRED: readonly string[] = Object.keys(TROLL_WEIGHTS).filter((k) => TROLL_WEIGHTS[k] >= 8);

/**
 * Roll one species out of `available`, weighted by `TROLL_WEIGHTS`.
 *
 * `quality` sharpens the bias rather than gating a list: a clean, well-trimmed spread skews hard
 * toward the fish it was set for, while a sloppy one flattens out toward whatever happened to be
 * swimming past. Null only when there is genuinely nothing in the water to hook.
 */
export function pickTrollSpecies(available: readonly string[], quality: number, rng: () => number = Math.random): string | null {
  if (!available.length) return null;
  const q = Math.max(0, Math.min(1, quality));
  // A clean spread raises the premium fish well above the rest; a poor one barely separates them.
  const sharpen = 0.6 + 1.0 * q;
  let total = 0;
  const w: number[] = [];
  for (const k of available) {
    const v = Math.pow(TROLL_WEIGHTS[k] ?? TROLL_BASE_WEIGHT, sharpen);
    w.push(v);
    total += v;
  }
  let r = rng() * total;
  for (let i = 0; i < available.length; i++) {
    r -= w[i];
    if (r <= 0) return available[i];
  }
  return available[available.length - 1];
}

