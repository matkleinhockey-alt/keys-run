/**
 * Fish leave the water by shrinking, not by blinking out (fish/thin.ts).
 *
 * The drawn count is an integer, so landing a catch deleted a fish mid-frame while the player was
 * looking at the school. These pin the eased float that fixes it, and — just as importantly — pin
 * that it stays entirely out of the way of water nobody has fished.
 */
import { describe, it, expect } from 'vitest';
import { FADE_S, stepShownAnim, shownCount } from '../src/entities/fish/thin.js';

describe('a fish fades instead of popping', () => {
  it('snaps on first sight: arriving at a worked reef costs no animation', () => {
    expect(stepShownAnim(undefined, 4, 1 / 60)).toBe(4);
  });

  it('takes FADE_S to lose one fish, and lands exactly on the target', () => {
    const dt = 1 / 60;
    let a = 12;
    let frames = 0;
    while (a > 11 && frames < 1000) { a = stepShownAnim(a, 11, dt); frames++; }
    expect(a).toBe(11); // exactly, so it cannot jitter around the target forever
    expect(frames * dt).toBeCloseTo(FADE_S, 1);
  });

  it('grows back the same way as the spot recovers', () => {
    const dt = 1 / 60;
    let a = 4;
    let frames = 0;
    while (a < 5 && frames < 1000) { a = stepShownAnim(a, 5, dt); frames++; }
    expect(a).toBe(5);
    expect(frames * dt).toBeCloseTo(FADE_S, 1);
  });

  it('never overshoots, however long the frame', () => {
    expect(stepShownAnim(12, 4, 10)).toBe(4);
    expect(stepShownAnim(4, 12, 10)).toBe(12);
  });

  it('a stalled or nonsense frame time never moves a fish backwards or to NaN', () => {
    for (const dt of [0, -1, NaN, Infinity, -Infinity]) {
      const out = stepShownAnim(8, 3, dt);
      expect(Number.isFinite(out)).toBe(true);
      expect(out).toBeLessThanOrEqual(8);
      expect(out).toBeGreaterThanOrEqual(3);
    }
  });

  it('a corrupt stored value recovers by snapping rather than propagating NaN', () => {
    for (const bad of [NaN, Infinity, -Infinity, undefined]) {
      expect(stepShownAnim(bad as number | undefined, 6, 1 / 60)).toBe(6);
    }
  });

  /**
   * The load-bearing one. Pristine water must run today's code path, and the fade must not be a
   * way for it to sneak in: at full recovery the target IS the school size, so a school that has
   * never been thinned has nothing to ease toward and stays on the untouched path.
   */
  it('pristine water has nothing to animate', () => {
    const len = 12;
    for (const rec of [1, 0.9, 0.8, 42, NaN]) {
      expect(shownCount(len, rec)).toBe(len);
    }
  });

  it('a school eased back to full is indistinguishable from one never touched', () => {
    const len = 9;
    // the caller clears shownAnim once the float reaches the full count; this is that condition
    const a = stepShownAnim(8.97, shownCount(len, 1), 1);
    expect(a).toBe(len);
    expect(Math.ceil(a - 1e-6)).toBe(len);
  });
});
