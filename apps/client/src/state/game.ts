/**
 * Boat placement: making sure the boat starts (or restarts after a boat swap) in open water,
 * never inside a dock, a moored boat or a piling.
 *
 * Ported faithfully from legacy/index.html:1958-1975 (`spotClear`/`unstick`). Legacy's
 * `spotClear` queried the `PGRID` spatial hash directly; here it scans the flat `Piling[]`
 * instead — same reasoning as world/bridge.ts's doc comment (the grid never changes which
 * pilings are in range, only how fast you find them, and this dataset is small enough that the
 * flat scan is simpler to keep honest against the physics oracle).
 */
import { depthAt } from '@keysrun/shared/world/depth';
import { shoreInfo } from '@keysrun/shared/world/chain';
import type { DockRect, Piling } from '@keysrun/shared/sim/boat';

export interface SpawnCheckEnv {
  draft: number;
  len: number;
  dockRects: readonly DockRect[];
  pilings: readonly Piling[];
}

/** legacy `spotClear` (index.html:1959-1965). */
export function spotClear(x: number, z: number, env: SpawnCheckEnv): boolean {
  const R = env.len * 0.5 + 6;
  if (depthAt(x, z) < env.draft + 0.6 || shoreInfo(x, z).d < R + 6) return false;
  for (const r of env.dockRects) {
    const cx = Math.max(r.x0, Math.min(r.x1, x)), cz = Math.max(r.z0, Math.min(r.z1, z));
    if (Math.hypot(x - cx, z - cz) < R) return false;
  }
  for (const p of env.pilings) {
    if (Math.hypot(x - p.x, z - p.z) < R) return false;
  }
  return true;
}

/** legacy `unstick` (index.html:1966-1975): spiral-search for the nearest clear spot. */
export function findClearSpot(x0: number, z0: number, env: SpawnCheckEnv, fallback: { x: number; z: number }): { x: number; z: number } {
  if (spotClear(x0, z0, env)) return { x: x0, z: z0 };
  for (let r = 12; r <= 400; r += 12) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2, x = x0 + Math.cos(a) * r, z = z0 + Math.sin(a) * r;
      if (spotClear(x, z, env)) return { x, z };
    }
  }
  return { x: fallback.x, z: fallback.z };
}
