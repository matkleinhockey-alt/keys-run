/**
 * Shared numeric constants for the underwater render stack (docs/ARCHITECTURE.md "The underwater
 * world" → "Rendering" + the depth-band table). Kept in one place so fog-override.ts (GLSL,
 * interpolated into a shader string), water.ts's Snell's-window branch, marine-snow.ts and
 * transition.ts all agree on the same numbers instead of re-deriving them.
 *
 * Plain TypeScript, no three.js — these are just numbers; each consumer decides how to use them
 * (JS math vs. interpolated into a GLSL template string).
 */

/** ARCHITECTURE.md's per-channel extinction coefficients, 1/m. Water eats red first. */
export const EXTINCTION = { r: 0.45, g: 0.09, b: 0.03 } as const;

/** Linear-light tint water scatters toward at depth (the "inscatter" term in
 * `transmittance*surface + inscatter*(1-transmittance)`) — a deep blue-green veil, picked to land
 * close to the depth-band table's band-4/5 ambient colour. */
export const INSCATTER_COLOR = { r: 0.045, g: 0.34, b: 0.47 } as const;

/** Ambient light intensity falls off as `exp(-cameraDepth / AMBIENT_HALF_DEPTH)` — tuned so it is
 * under 10% by 20 m, matching the depth-band table ("ambient light dropping to <10% below 20 m"). */
export const AMBIENT_HALF_DEPTH = 11;

/** Vertical half-width (metres) of the smoothstep band straddling y=0 that both the global fog
 * override (GLSL, purely a function of the live `cameraPosition` uniform) and transition.ts (JS,
 * for FOV/lens-wetting/audio-hook state) treat as "crossing the surface". At a plausible dive speed
 * (~1-1.5 m/s) a 0.15 m half-band is ~0.2-0.3 s of crossing time — matching ARCHITECTURE.md's
 * "~200 ms crossing" / "blended over ~0.3 s" without needing a separate stateful timer for the
 * shader side (it falls out of camera position alone, so it is correct even after a teleport). */
export const SURFACE_BAND = 0.15;

/** Depth bands (docs/ARCHITECTURE.md table): visibility (m) and ambient-light fraction by depth. */
export const DEPTH_BANDS = [
  { depth: 0, vis: 30, ambient: 1.0 },
  { depth: 5, vis: 25, ambient: 0.75 },
  { depth: 10, vis: 20, ambient: 0.45 },
  { depth: 15, vis: 15, ambient: 0.22 },
  { depth: 20, vis: 10, ambient: 0.09 },
] as const;

export function visibilityAt(depth: number): number {
  if (depth <= DEPTH_BANDS[0].depth) return DEPTH_BANDS[0].vis;
  for (let i = 1; i < DEPTH_BANDS.length; i++) {
    if (depth <= DEPTH_BANDS[i].depth) {
      const a = DEPTH_BANDS[i - 1], b = DEPTH_BANDS[i];
      const t = (depth - a.depth) / (b.depth - a.depth);
      return a.vis + (b.vis - a.vis) * t;
    }
  }
  return DEPTH_BANDS[DEPTH_BANDS.length - 1].vis;
}

/** Caustics (ARCHITECTURE.md: "full strength 0-10 m, gone by 20 m"). */
export const CAUSTICS_FULL_DEPTH = 10;
export const CAUSTICS_GONE_DEPTH = 20;

/** Water's refractive index and the derived Snell's-window critical angle (radians) — the ~96 deg
 * figure in ARCHITECTURE.md is ~2x this half-angle (asin(1/1.3333) ~= 48.6 deg -> ~97.2 deg cone). */
export const WATER_IOR = 1.3333;
export const SNELL_CRITICAL_ANGLE = Math.asin(1 / WATER_IOR);

/** Marine snow: particle density scales up with depth, roughly matching the "deep water gets
 * murkier/snowier" read even though real marine snow isn't strictly depth-correlated — it's the
 * cheapest way to make depth *read* as depth once the diver is below where caustics/Snell's window
 * stop doing that job for us. */
export const MARINE_SNOW_MAX = 900;
export const MARINE_SNOW_FULL_DEPTH = 25;
