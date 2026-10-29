/**
 * Everything a person can stand on outside the town, for the walker (shared sim/walker.ts):
 *  - the land itself: any ground above the waterline (`landH`), so stepping off a dock anywhere
 *    puts you on the key it belongs to, and the shoreline is the edge you cannot walk past;
 *  - the public fishing piers (shared world/piers.ts);
 *  - the private docks behind the waterfront houses (world/waterfront.ts hands their planks over
 *    as `WalkDock`s).
 * Plus "is this a deck you can fish off" for rod fishing ashore.
 *
 * The town (pad, marina decks, ramp) still answers first through town.ts's `groundAt`; this is
 * what is underneath when it says null.
 */
import { landH } from '@keysrun/shared/world/depth';
import { PAD_Y, inTownFootprint, findBerth } from '@keysrun/shared/world/town';
import { pierAt, pierGround, pierBerth, PIER_TOP } from '@keysrun/shared/world/piers';

/** Ground lower than this is the wet edge of a beach: the walker stops at it. */
export const DRY_H = 0.15;

/** A straight plank walkway: from (x0,z0) along unit (nx,nz) for `len` metres, `w` wide. */
export interface WalkDock {
  x0: number; z0: number; nx: number; nz: number;
  len: number; w: number;
  /** Plank top height. */
  top: number;
  name: string;
}

/** Natural ground at (x,z), or null in the water. */
export function naturalGround(x: number, z: number): number | null {
  const h = landH(x, z);
  // The town pad stands 0.75 m proud of the fill round it, a hair over the walker's STEP_MAX; a
  // two-metre apron at kerb height lets you step down off its edge instead of finding it a wall.
  if (inTownFootprint(x, z, 2) && h > DRY_H) return Math.max(h, PAD_Y - 0.6);
  return h >= DRY_H ? h : null;
}

function dockLocal(d: WalkDock, x: number, z: number): [number, number] {
  const dx = x - d.x0, dz = z - d.z0;
  return [dx * d.nx + dz * d.nz, dx * -d.nz + dz * d.nx];
}

export function dockAt(docks: readonly WalkDock[], x: number, z: number): WalkDock | null {
  for (const d of docks) {
    const [a, c] = dockLocal(d, x, z);
    if (a >= 0 && a <= d.len && Math.abs(c) <= d.w / 2) return d;
  }
  return null;
}

/** The nearest standing point on a dock within `reach`, for tying up. */
export function dockBerth(docks: readonly WalkDock[], x: number, z: number, reach: number): { dock: WalkDock; x: number; z: number; dist: number } | null {
  let best: { dock: WalkDock; x: number; z: number; dist: number } | null = null;
  for (const d of docks) {
    const [a, c] = dockLocal(d, x, z);
    const half = Math.max(0, d.w / 2 - 0.45);
    const ca = Math.max(2, Math.min(d.len - 0.45, a)), cc = Math.max(-half, Math.min(half, c));
    const px = d.x0 + d.nx * ca - d.nz * cc, pz = d.z0 + d.nz * ca + d.nx * cc;
    const dist = Math.hypot(px - x, pz - z);
    if (dist <= reach && (!best || dist < best.dist)) best = { dock: d, x: px, z: pz, dist };
  }
  return best;
}

/** Piers, then docks, then the land. (The town's own surfaces are asked before this.) */
export function outsideGround(docks: readonly WalkDock[], x: number, z: number): number | null {
  const p = pierGround(x, z);
  if (p !== null) return p;
  const d = dockAt(docks, x, z);
  if (d) return d.top;
  return naturalGround(x, z);
}

/** Can you fish from where you are standing: on a pier, a private dock, or a marina's planks? */
export function fishableDeck(docks: readonly WalkDock[], x: number, z: number): string | null {
  const p = pierAt(x, z);
  if (p) return p.name;
  const d = dockAt(docks, x, z);
  if (d) return d.name;
  const m = findBerth(x, z, 0.05);
  return m ? m.marina.name : null;
}

export { pierBerth, PIER_TOP };
