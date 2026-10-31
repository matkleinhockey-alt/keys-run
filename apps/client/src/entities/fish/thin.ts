/**
 * Worked water is visibly emptier: how many members of a school are drawn (and speared) given how
 * recovered the water under it is (net/ocean.ts `recoveryAt`, 0..1).
 *
 * WHY THIS CUE. The ocean ledger makes fished spots yield smaller fish (up to 40% lighter), but
 * nothing showed it, so a worked-out reef read as the game quietly cheating. The most honest
 * signal is the ocean itself: fewer fish in the water over a spot you have hammered. It needs no
 * label, no number, no toast, and a player who never reads a tooltip still sees "this reef is
 * picked over".
 *
 * THE NO-OP RULE. At or above `FULL_AT` the answer is exactly the school's own count, and the
 * caller leaves `SchoolState.shown` undefined, so pristine and offline water run today's code
 * path untouched. A casual handful of fish (recovery about 0.78, see sim/ocean.ts) is already
 * above the line and shows nothing; an hour of steady work (0.09) shows 38% of the school.
 *
 * Members are hidden from the TAIL of the array, so the same fish go first every time and a
 * school thins and refills in a fixed order instead of shimmering. The floor keeps a school
 * alive: picked over, not erased (the spot still produces keepers, same as the size curve).
 *
 * FISH DO NOT POP. The count is an integer, so landing a catch used to delete a fish from the
 * water in one frame while you were looking at it. `stepShownAnim` keeps a float that eases
 * toward it, and the member at the boundary draws at the fractional scale, so one fish shrinks
 * away over `FADE_S` and grows back the same way as the spot recovers. A geometric scale tween
 * rather than an opacity fade for the same reason remote boats use one (net/remote-boats.ts):
 * fish materials are shared across every instance of a species, so fading one instance's
 * material would fade every other fish of that species in the ocean.
 *
 * A school's FIRST sight of worked water snaps instead of easing — arriving at a picked-over
 * reef should just look picked over, and there is no pop to hide when nobody was watching yet.
 */
/** Recovery at or above which nothing is hidden. */
export const FULL_AT = 0.8;
/** Fraction of a school still drawn in fully fished-out water. */
export const KEEP_MIN = 0.3;

/** Fraction of a school drawn, KEEP_MIN..1. NaN, negative, > 1 and non-numbers are all sane. */
export function keepFraction(rec: number): number {
  if (typeof rec !== 'number' || Number.isNaN(rec) || rec >= FULL_AT) return 1;
  const r = rec < 0 ? 0 : rec;
  return KEEP_MIN + (1 - KEEP_MIN) * (r / FULL_AT);
}

/** How many of `count` members to draw: all of them (pristine) or at least one. */
export function shownCount(count: number, rec: number): number {
  const k = keepFraction(rec);
  if (k >= 1 || count <= 0) return count;
  return Math.max(1, Math.min(count, Math.ceil(count * k)));
}

/** Seconds one fish takes to fade out, or back in. Long enough to read as leaving rather than
 * blinking, short enough that a catch feels like it took something. */
export const FADE_S = 0.55;

/**
 * Eases the drawn-count float toward `target`. `undefined` (a school not yet thinned, or seen
 * for the first time) snaps, so arriving somewhere worked costs no animation.
 */
export function stepShownAnim(anim: number | undefined, target: number, dt: number): number {
  if (typeof anim !== 'number' || !Number.isFinite(anim)) return target;
  const step = (Number.isFinite(dt) && dt > 0 ? dt : 0) / FADE_S;
  const d = target - anim;
  if (Math.abs(d) <= step) return target;
  return anim + Math.sign(d) * step;
}
