/**
 * When a bird-and-bait hotspot is "on". Pure function of (world seed, site id, wall-clock
 * second), so every client — and `apps/sim` — agrees on which spots are boiling right now
 * without exchanging a byte (docs/ARCHITECTURE.md "Seeding").
 *
 * Replaced legacy's per-site countdown timer (`fT -= dt; if (fT<=0) toggle`), which was
 * `Math.random()` + local dt: two players saw different frenzies, and a frenzy could not be a
 * thing anybody races to because nobody else could see it. Time is cut into fixed buckets; each
 * bucket independently hashes (site, bucketIndex) to "does a frenzy happen here this bucket" and
 * where inside the bucket it starts — position-derived, never iteration-order-derived, so adding
 * a site never shifts another site's schedule.
 *
 * Tuned so ~1 in 5 sites is on at any moment: with ~40 sites over the whole map that leaves a
 * frenzy within a few km nearly always, but never a crowd of them (a frenzy everywhere is a
 * frenzy nowhere). Duration is 30-60 s: long enough to be worth racing ~1 km at planing speed,
 * short enough that a lazy player misses it and the next one is a new decision.
 *
 * No three.js here (CI: check:no-three).
 */
import { hashCell } from '../rng/index.js';

/** Bucket length in seconds. A site gets at most one frenzy per bucket. */
export const FRENZY_BUCKET_S = 120;
export const FRENZY_CHANCE = 0.5;
export const FRENZY_MIN_S = 30;
export const FRENZY_MAX_S = 60;

/** Independent salts for the three draws; kept clear of the client's `SALT` table (101-...). */
const SALT_ON = 9001, SALT_START = 9002, SALT_LEN = 9003;

/** Whether site `site` is in a frenzy at unix-seconds `nowS`. Frenzies never straddle a bucket
 * boundary (start is clamped so start+len <= bucket) so each bucket is self-contained. */
export function frenzyActive(seed: number, site: number, nowS: number): boolean {
  const b = Math.floor(nowS / FRENZY_BUCKET_S);
  if (hashCell(seed, site, b, SALT_ON) >= FRENZY_CHANCE) return false;
  const len = FRENZY_MIN_S + (FRENZY_MAX_S - FRENZY_MIN_S) * hashCell(seed, site, b, SALT_LEN);
  const start = (FRENZY_BUCKET_S - len) * hashCell(seed, site, b, SALT_START);
  const into = nowS - b * FRENZY_BUCKET_S;
  return into >= start && into < start + len;
}
