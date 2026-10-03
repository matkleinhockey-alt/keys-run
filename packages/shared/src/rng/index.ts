/**
 * Deterministic, position-derived randomness.
 *
 * This module is NEW — it does not exist in legacy/index.html, which uses `Math.random()`
 * directly for almost everything except island placement (see world/chain.ts's `createSrand`).
 * docs/ARCHITECTURE.md's "Seeding" section calls for replacing those `Math.random()` call sites
 * with `hashCell(seed, cx, cz, salt)`: placement derived from *position*, not from iteration
 * order, so adding one object later doesn't reshuffle everything placed after it, and the same
 * cell always has the same content on every client and the server.
 */

export type Rng = () => number;

/** 32-bit finalizer mix (MurmurHash3's fmix32) — spreads low-entropy inputs across all 32 bits. */
function fmix32(hIn: number): number {
  let h = hIn >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * mulberry32: a small, fast 32-bit PRNG with good practical statistical quality. Used standalone
 * for quick deterministic streams, and internally to expand a single 32-bit seed into
 * xoshiro128**'s 128-bit state.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * xoshiro128** (Blackman & Vigna) — a higher-quality 32-bit PRNG for streams that run longer or
 * matter more statistically (e.g. resident-school member generation) than mulberry32's uses.
 * Seeded from a single 32-bit integer via mulberry32, matching common practice for this
 * generator (its own authors specify only the 128-bit state, not how to derive it from a
 * shorter seed).
 */
export function xoshiro128ss(seed: number): Rng {
  const seedGen = mulberry32(seed);
  let s0 = (seedGen() * 4294967296) >>> 0;
  let s1 = (seedGen() * 4294967296) >>> 0;
  let s2 = (seedGen() * 4294967296) >>> 0;
  let s3 = (seedGen() * 4294967296) >>> 0;
  return function next(): number {
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result / 4294967296;
  };
}

/**
 * Deterministic hash of a world cell into [0, 1): same (seed, cx, cz, salt) always produces the
 * same value, on any machine, in any call order — unlike `Math.random()`, which depends on how
 * many times it's been called before. `salt` distinguishes independent uses of the same cell
 * (e.g. "which species" vs "how many" vs "exact offset").
 */
export function hashCell(seed: number, cx: number, cz: number, salt: number): number {
  let h = fmix32(seed | 0);
  h = fmix32((h ^ Math.imul((cx | 0) + 0x9e3779b9, 0x85ebca6b)) >>> 0);
  h = fmix32((h ^ Math.imul((cz | 0) + 0x9e3779b9, 0xc2b2ae35)) >>> 0);
  h = fmix32((h ^ Math.imul((salt | 0) + 0x9e3779b9, 0x27d4eb2f)) >>> 0);
  return h / 4294967296;
}

/**
 * Pick one entry from a `[item, weight]` table in proportion to its weight, using one draw from
 * `rng`. Mirrors the shape of legacy's inline weighted-pick loops (e.g. `pickSpecies`,
 * index.html:2650-2653) but is new, generic code — not an extraction — so it is not covered by
 * the golden fixture; `weightedPick`'s own tests check weight-proportionality over many samples
 * instead of exact values.
 */
export function weightedPick<T>(rng: Rng, table: ReadonlyArray<readonly [T, number]>): T {
  let total = 0;
  for (const [, w] of table) total += w;
  let r = rng() * total;
  for (const [item, w] of table) {
    r -= w;
    if (r <= 0) return item;
  }
  return table[table.length - 1][0];
}
