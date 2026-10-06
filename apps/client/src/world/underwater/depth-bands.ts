/**
 * Shared numeric constants for the underwater render stack (docs/ARCHITECTURE.md "The underwater
 * world" → "Rendering" + the depth-band table). Kept in one place so fog-override.ts (GLSL,
 * interpolated into a shader string), water.ts's Snell's-window branch, marine-snow.ts and
 * transition.ts all agree on the same numbers instead of re-deriving them.
 *
 * Plain TypeScript, no three.js — these are just numbers; each consumer decides how to use them
 * (JS math vs. interpolated into a GLSL template string).
 */

/**
 * Per-channel extinction coefficients, 1/m. Water eats red first — that asymmetry is what sells
 * depth, and the *ratio* here is kept faithful to ARCHITECTURE.md's physical values
 * (0.45 / 0.09 / 0.03).
 *
 * The magnitudes, however, are deliberately scaled down from those physical numbers. The shader
 * applies them over `uwDist + uwCameraDepth` (object-to-eye plus the downwelling path), so at a
 * mere 3 m depth looking at coral 5 m away the physical red coefficient gives
 * `exp(-0.45 * 8) ≈ 0.03` — 97% of red annihilated before the diver has left the shallows. That
 * is roughly right for turbid open ocean and badly wrong for the clear Keys water this game is
 * set in, where real reef photography at 3-5 m still shows vivid mustard elkhorn and orange
 * sponges. Rendering those as grey-green ghosts made the whole reef read as "murky", which was
 * the single biggest visual problem in the first integrated dive.
 *
 * EXTINCTION_SCALE tempers the curve so colour survives bands 1-2 and still collapses by band 5.
 * Treat it as an art-direction dial, not a physics constant: raise it toward 1.0 for a murkier,
 * more northern-water look, lower it for gin-clear tropical water.
 */
export const EXTINCTION_SCALE = 0.38;
/**
 * The per-channel *ratio* is softened from water's true 0.45 / 0.09 / 0.03 (15:3:1) to roughly
 * 4.9:2.1:1. This is the second art-direction dial and it is the one that controls colour, where
 * EXTINCTION_SCALE above controls haze.
 *
 * Why: the shader applies these over `uwDist + uwCameraDepth`, so a diver at 7 m looking at coral
 * 5 m away is on a 12 m path. At the true ratio that left red at `exp(-0.171*12) = 0.13` against
 * green at 0.66, so a burnt-orange coral (0.80, 0.35, 0.15) arrived as (0.10, 0.23, 0.13) —
 * **green dominant**. Every warm colour in the reef collapsed to the same green-teal before it
 * reached the eye, which is why the reef read as "all one green" whatever hue the coral actually
 * was. The filter sat upstream of the palette, so no choice in world/reef/** could escape it.
 *
 * Scaling the whole curve down instead is the obvious fix and it is wrong: it also removes the
 * haze that keeps bright sand in range, and the sea floor blows out to flat white (measured, not
 * predicted). Softening only the ratio keeps total attenuation — and therefore the haze and the
 * draw-distance falloff — essentially where it was, while letting red survive to mid-range.
 *
 * At 12 m this now leaves r=0.37 / g=0.65 / b=0.81 and that coral arrives at (0.29, 0.23, 0.12):
 * recognisably orange. The depth cue is intact where it matters — at band 5 (25 m down looking
 * 10 m) red is still down to 0.05 against blue at 0.55, so the deep goes blue and colourless
 * exactly as the depth-band table intends.
 */
export const EXTINCTION = {
  r: 0.22 * EXTINCTION_SCALE,
  g: 0.095 * EXTINCTION_SCALE,
  b: 0.045 * EXTINCTION_SCALE,
} as const;

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
