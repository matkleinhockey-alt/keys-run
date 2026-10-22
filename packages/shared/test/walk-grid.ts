/**
 * Test helper: breadth-first search over the walker's OWN `canStand` rule on a regular grid in the
 * town's local (u, v) frame. "Reachable" here means exactly what it means to the player: a body of
 * `WALK_RADIUS` can stand there, on ground within `STEP_MAX`, clear of every collider. So a shop whose
 * counter is walled off by its own furniture fails this, however good its coordinates look.
 */
import { canStand, type WalkerEnv } from '../src/sim/walker.js';
import { COLLIDERS, TOWN_FRAME, groundAt, toWorld, PAD_Y } from '../src/world/town.js';

export const ENV: WalkerEnv = { ground: groundAt, colliders: COLLIDERS };
export const STEP = 0.25;

export interface Grid { seen: Map<string, string | null>; cells: number }

const key = (i: number, j: number): string => `${i},${j}`;

export interface Bounds { u0: number; u1: number; v0: number; v1: number }

/** Flood fill from local (u0, v0), never leaving `within` (the street is 30,000 m2 and nobody needs all of it). */
export function flood(u0: number, v0: number, within: Bounds, limit = 400000): Grid {
  const seen = new Map<string, string | null>();
  const q: Array<[number, number]> = [];
  const I = Math.round(u0 / STEP), J = Math.round(v0 / STEP);
  seen.set(key(I, J), null); q.push([I, J]);
  while (q.length && seen.size < limit) {
    const [i, j] = q.shift()!;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const ni = i + di, nj = j + dj, k = key(ni, nj);
      if (seen.has(k)) continue;
      if (ni * STEP < within.u0 || ni * STEP > within.u1 || nj * STEP < within.v0 || nj * STEP > within.v1) continue;
      const [x, z] = toWorld(TOWN_FRAME, ni * STEP, nj * STEP);
      if (!canStand(ENV, x, z, PAD_Y)) continue;
      // A diagonal must not cut a wall corner: both orthogonal neighbours have to be standable too.
      if (di !== 0 && dj !== 0) {
        const [xa, za] = toWorld(TOWN_FRAME, (i + di) * STEP, j * STEP), [xb, zb] = toWorld(TOWN_FRAME, i * STEP, (j + dj) * STEP);
        if (!canStand(ENV, xa, za, PAD_Y) || !canStand(ENV, xb, zb, PAD_Y)) continue;
      }
      seen.set(k, key(i, j)); q.push([ni, nj]);
    }
  }
  return { seen, cells: seen.size };
}

/** The nearest reached cell to local (u, v) within `r` metres, or null. */
export function nearestReached(g: Grid, u: number, v: number, r: number): [number, number] | null {
  let best: [number, number] | null = null, bd = r;
  const n = Math.ceil(r / STEP);
  const I = Math.round(u / STEP), J = Math.round(v / STEP);
  for (let di = -n; di <= n; di++) for (let dj = -n; dj <= n; dj++) {
    if (!g.seen.has(key(I + di, J + dj))) continue;
    const d = Math.hypot((I + di) * STEP - u, (J + dj) * STEP - v);
    if (d <= bd) { bd = d; best = [(I + di) * STEP, (J + dj) * STEP]; }
  }
  return best;
}

/** The chain of cells from the flood's origin to the cell at (u, v), as local points. */
export function pathTo(g: Grid, u: number, v: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let k: string | null | undefined = key(Math.round(u / STEP), Math.round(v / STEP));
  while (k) {
    const [i, j] = k.split(',').map(Number);
    out.push([i * STEP, j * STEP]);
    k = g.seen.get(k);
  }
  return out.reverse();
}
