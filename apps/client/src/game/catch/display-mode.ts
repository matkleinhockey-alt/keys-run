/**
 * One rule for "can a person hold this fish up, or does it go on the crane", shared by the two
 * places that present a catch:
 *
 *  - the boat deck (`game/catch/catch-flow.ts`'s `setupPhoto`), and
 *  - the catch card (`game/catch/portrait.ts`'s `show`).
 *
 * ## Why this is shared rather than a number in each file
 *
 * They disagreed. The deck hung anything `weight >= 25 || lenM > 1.7`, while the card held
 * anything `lenM <= 1.5` — and the card was never given the weight at all, only a length. A 25 lb
 * mahi is 1.17 m, so it cleared the card's length test and was rendered *in the captain's hands*
 * on the card while simultaneously hanging from the gin pole on the deck behind it. Two different
 * answers to the same question, in the same frame.
 *
 * ## The rule
 *
 * Both must pass: a fish is holdable only if it is short enough to get your hands around AND light
 * enough to lift. Weight is the one that matters most — a 25 lb fish held at arm's length is about
 * the limit of a convincing grip-and-grin, and past that real anglers put it on the scale rather
 * than lift it. Length catches the other case: a 1.6 m barracuda is only ~20 lb but is absurd to
 * present two-handed at chest height.
 */

/** Longest fish a captain can plausibly hold up, metres (snout to tail tip). */
export const HOLDABLE_MAX_LEN_M = 1.5;

/** Heaviest fish a captain can plausibly hold up, pounds. */
export const HOLDABLE_MAX_WEIGHT_LB = 25;

/**
 * True when the catch should go in the captain's hands, false when it belongs on the gin pole.
 *
 * `weightLb` is optional only because `portrait.show()` historically took a length and nothing
 * else. When it is omitted the length test alone decides — which is the old card behaviour, and
 * is why callers that *can* supply a weight always should.
 */
export function isHoldable(lenM: number, weightLb?: number): boolean {
  if (lenM > HOLDABLE_MAX_LEN_M) return false;
  if (weightLb !== undefined && weightLb >= HOLDABLE_MAX_WEIGHT_LB) return false;
  return true;
}
