/**
 * INTEGRATION POINT — read this before touching placement.ts or chunk-manager.ts.
 *
 * The seafloor agent (feat/seafloor, not yet merged as of this module's creation) is rewriting
 * apps/client/src/world/seafloor.ts so that `floorY` becomes identity (`d => -d`) over chunked LOD
 * terrain, and is expected to export a `seafloorHeightAt(x, z)` that returns the real ground
 * height at any world (x,z) — see docs/ARCHITECTURE.md "Seafloor" and this task's "Interfaces"
 * section ("Code against that interface... Don't block on it").
 *
 * This module is not allowed to edit world/seafloor.ts, and that export doesn't exist on
 * `integration` yet. Rather than guess at its name and ship a dangling import that breaks the
 * build the moment it lands, `reefGroundY` below already implements the *documented contract*
 * of that future function directly from the same pure, three.js-free `depthAt` every other
 * system already depends on: `y = -depthAt(x, z)`. Once `feat/seafloor` merges, swap this
 * function's body for `return seafloorHeightAt(x, z);` (one line) — every call site in this
 * directory goes through `reefGroundY`, so that is the only edit required.
 */
import { seafloorHeightAt } from '../terrain/heightfield.js';

/**
 * Ground height (world Y, metres) to seat a reef instance's base at world (x,z).
 *
 * The swap the header above anticipated: this now returns the terrain mesh's own height
 * (`seafloorHeightAt`, relief included), not `-depthAt`. Required since the floor gained rock and
 * coral relief (shared/world/relief.ts): seated on `-depthAt`, every coral and gorgonian would hang
 * in mid-water above a groove or sink into the top of an outcrop. It also removes a standing
 * discrepancy (exact `depthAt` vs the mesh's 10 m `depthFast` grid) that left some instances a few
 * centimetres off the surface they stand on.
 */
export function reefGroundY(x: number, z: number): number {
  return seafloorHeightAt(x, z);
}
