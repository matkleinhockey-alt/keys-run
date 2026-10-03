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
import { depthAt } from '@keysrun/shared/world/depth';

/** Ground height (world Y, metres) to seat a reef instance's base at world (x,z). See header. */
export function reefGroundY(x: number, z: number): number {
  return -depthAt(x, z);
}
