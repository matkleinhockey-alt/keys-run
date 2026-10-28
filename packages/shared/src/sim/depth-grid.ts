/**
 * Fast depth/inlet lookup grid, ported faithfully from legacy/index.html lines 617-625
 * (docs/ARCHITECTURE.md's "depth cache grids (DEPTHG/INLETG, depthFast, depthTex)").
 *
 * This is pure math — a bilinearly-interpolated cache over `depthAt` — with zero three.js
 * dependency. It lives under packages/shared/src/sim/ (not src/world/) because its only
 * consumer in Phase 0 is the boat physics integrator (`ampAt`, used by stepBoat's buoyancy
 * and wave-surge code): legacy's buoyancy integrator reads the *grid-interpolated* depth,
 * not the exact closed-form `depthAt`, so stepBoat must use this same grid to match legacy's
 * trajectory bit-for-bit (see boat-trajectory.test.ts). The client's water shader builds its
 * `depthTex` DataTexture from this same grid (see apps/client/src/world/water.ts) so the two
 * never drift apart.
 *
 * ⚠ 5.9 MB allocated at import time (two Float32Arrays of 861×861) — see
 * docs/ARCHITECTURE.md's "Existing hazards to fix en route". Preserved as-is for Phase 0;
 * not a regression, legacy already pays this cost at boot.
 */

import { chainZ } from '../world/chain.js';
import { depthAt, OLDBR, SURF_BREAK, WORLD } from '../world/depth.js';
import { ampFor, chopAmpFor, waveHBase, waveSlope, DEFAULT_SW, DEFAULT_CH } from '../waves/index.js';
import { clamp } from '../internal/math.js';

/**
 * The largest value the inlet/amplitude field may carry, and the scale the client's depth texture
 * packs it with. The tidal inlets only ever reach 1, and the byte the shader reads was clamped
 * there, so nothing could ever be rougher than 1.9x its depth's amplitude — which is calmer than
 * open water, and no use at all for a surf break. Raising the ceiling means the texture has to be
 * packed against it; water.ts multiplies by this on the way back out so the shader and `ampAt`
 * still compute the same number.
 */
export const INLET_MAX = 4;

const DG = 10;
const DGN = Math.ceil(WORLD.size / DG) + 1;
const DG0X = WORLD.x0;
const DG0Z = WORLD.z0;

function buildGrids(): { depth: Float32Array; inlet: Float32Array } {
  const depth = new Float32Array(DGN * DGN);
  const inlet = new Float32Array(DGN * DGN);
  for (let j = 0; j < DGN; j++) {
    for (let i = 0; i < DGN; i++) {
      const x = DG0X + i * DG, z = DG0Z + j * DG, d = depthAt(x, z), k = j * DGN + i;
      depth[k] = d;
      const dz = z - chainZ(x);
      inlet[k] = (d > 3 && Math.abs(dz) < 85) ? (1 - Math.abs(dz) / 85)
        : (d > 3 && x > OLDBR.x0 && x < OLDBR.x1 && Math.abs(dz - OLDBR.dz) < 50) ? 0.5 * (1 - Math.abs(dz - OLDBR.dz) / 50)
        : 0;
      // The surf break (world/depth.ts's SURF_BREAK). Swell shoaling onto a bar is the one place
      // in this world where shallow means BIGGER, so it goes well past the 0..1 the tidal inlets
      // use — see INLET_MAX. Gated on depth so it neither washes over the dry beach nor keeps
      // standing up out in water too deep to feel the bottom.
      const sd = Math.hypot(x - SURF_BREAK.x, z - SURF_BREAK.z);
      if (sd < SURF_BREAK.r && d > 1.1 && d < 9) {
        const near = 1 - sd / SURF_BREAK.r;
        // Steepest where the bar is shallowest: the wave feels the bottom and stands up.
        const shoal = clamp((10 - d) / 5, 0, 1);
        inlet[k] = Math.max(inlet[k], INLET_MAX * near * near * shoal);
      }
    }
  }
  return { depth, inlet };
}

const { depth: DEPTHG, inlet: INLETG } = buildGrids();

/** Exposed for the client's water shader, which bakes the identical grid into a DataTexture. */
export { DEPTHG, INLETG, DG, DGN, DG0X, DG0Z };

function gridAt(G: Float32Array, x: number, z: number): number {
  const fx = clamp((x - DG0X) / DG, 0, DGN - 1.001), fz = clamp((z - DG0Z) / DG, 0, DGN - 1.001);
  const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * DGN + i;
  return (G[k] * (1 - u) + G[k + 1] * u) * (1 - v) + (G[k + DGN] * (1 - u) + G[k + DGN + 1] * u) * v;
}

/** Grid-interpolated depth (legacy `depthFast`). Faster, and slightly smoothed, vs. exact `depthAt`. */
export const depthFast = (x: number, z: number): number => gridAt(DEPTHG, x, z);

/** Grid-interpolated inlet blend factor, 0..1 (legacy inline `gridAt(INLETG,x,z)`). */
export const inletAt = (x: number, z: number): number => gridAt(INLETG, x, z);

/** Wave amplitude at a point, inlet-boosted (legacy `ampAt`). Used by the boat buoyancy integrator. */
export const ampAt = (x: number, z: number): number => ampFor(depthFast(x, z)) * (1 + 0.9 * inletAt(x, z));

/**
 * Wind-chop amplitude at a point (`chopAmpFor`), with a modest boost through the tidal cuts.
 *
 * The cut boost is clamped at 1 before scaling, which matters because `inletAt` runs to
 * INLET_MAX (4) over the surf break. That boost belongs to the SWELL — a bar is swell feeling the
 * bottom and standing up — and multiplying short wind chop by four there would put a metre of
 * stacked chop on the break on a calm day. Through a cut it is real, though: wind against tide in
 * a narrow channel is exactly what stacks chop up, and is what the Haulover sea state is named
 * after.
 */
export const chopAt = (x: number, z: number): number =>
  chopAmpFor(depthFast(x, z)) * (1 + 0.6 * Math.min(inletAt(x, z), 1));

/**
 * The sea surface at a point: swell and wind chop, each on its own depth envelope.
 *
 * This is what anything floating should use. `waveHBase(x, z, t, ampAt(x, z))` — the old idiom —
 * now gives you the swell only, because chop carries a separate envelope that has to be looked
 * up separately (`chopAt`), and a buoy riding a surface the water shader is not drawing is worse
 * than no chop at all. Two grid lookups instead of one; they are bilinear reads off a Float32Array.
 */
export const seaHAt = (x: number, z: number, t: number, sw = DEFAULT_SW, ch = DEFAULT_CH): number =>
  waveHBase(x, z, t, ampAt(x, z), sw, ch, chopAt(x, z));

/** Gradient of `seaHAt`. */
export const seaSlopeAt = (x: number, z: number, t: number, sw = DEFAULT_SW, ch = DEFAULT_CH): [number, number] =>
  waveSlope(x, z, t, ampAt(x, z), sw, ch, chopAt(x, z));
