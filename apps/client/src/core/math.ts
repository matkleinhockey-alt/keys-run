/**
 * Tiny helpers mirroring legacy/index.html:323 (`clamp`/`lerp`/`rand`). Not re-exported from
 * @keysrun/shared because that package deliberately keeps these as un-exported internals
 * (packages/shared/src/internal/math.ts) — every client-side module that needs them gets its
 * own trivial copy instead of reaching into the package's internals.
 */

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Cosmetic-only randomness (legacy `rand`, index.html:323) — never used for gameplay-relevant
 * placement; see docs/ARCHITECTURE.md "Seeding" and apps/client/src/state/constants.ts. */
export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
