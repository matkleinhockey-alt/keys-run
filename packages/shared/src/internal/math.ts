/**
 * Internal helpers mirroring legacy/index.html:323's `clamp`/`lerp`. Not part of the package's
 * public subpath exports — every world/wave module here needs them, so they live in one place
 * rather than being retyped at each call site. Faithful to the original expressions exactly.
 */

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
