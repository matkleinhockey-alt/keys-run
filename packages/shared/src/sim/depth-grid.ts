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
import { depthAt, OLDBR, WORLD } from '../world/depth.js';
import { ampFor } from '../waves/index.js';
import { clamp } from '../internal/math.js';

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
