/**
 * Public fishing piers: a walkway from the shore out to water deep enough to fish, with a T at
 * the end. You can tie up at one, walk it, and fish off it (apps/client/src/entities/land).
 *
 * ## Where they go
 * Chosen from the real shorelines (coast-data.ts), deterministically, the way waterfront.ts picks
 * its estates: walk each key's outline, and keep a spot only if
 *   - it is away from the town, the marinas, US-1, the creeks and the golf courses, and no part
 *     of it passes under either Seven Mile Bridge (BRIDGE_CLEAR);
 *   - the land behind it comes up to deck height within a few metres (so you step off the end of
 *     the pier onto the ground — the walker refuses a step of more than STEP_MAX);
 *   - the water reaches FISH_DEPTH within MAX_LEN, and nothing but water lies under the span.
 * The spots nearest the town marina win, PIER_SPACING apart, so the first one is a short walk
 * from where you tie up.
 *
 * Pure and deterministic, like everything in world/: the same piers for every player, and the
 * client renders them from this list (apps/client/src/world/piers.ts).
 */
import { islands, islandDist, chainZ, type Island } from './chain.js';
import { landH, depthAt, creekDist, MARINAS, OLDBR, WB } from './depth.js';
import { inTownFootprint } from './town.js';

/** Deck height above the still water. */
export const PIER_TOP = 1.3;
export const PIER_W = 3;
/** The T at the end: across, and along. */
export const HEAD_W = 14;
export const HEAD_D = 5;
/** Water this deep is worth a cast. */
const FISH_DEPTH = 2.4;
const MIN_LEN = 30;
const MAX_LEN = 150;
const PIER_SPACING = 900;
const MAX_PIERS = 6;
/** No part of a pier comes nearer than this to either bridge's line (the T is 14 m across). */
const BRIDGE_CLEAR = 16;

/** True if (x,z) is within BRIDGE_CLEAR of the new bridge or the old one. */
function underBridge(x: number, z: number): boolean {
  if (x >= WB.x0 && x <= WB.x1 && Math.abs(z - chainZ(x)) < BRIDGE_CLEAR) return true;
  return x >= OLDBR.x0 - BRIDGE_CLEAR && x <= OLDBR.x1 + BRIDGE_CLEAR && Math.abs(z - chainZ(x) - OLDBR.dz) < BRIDGE_CLEAR;
}

export interface Pier {
  id: string;
  name: string;
  /** Where the walkway starts, on the ground. */
  x0: number; z0: number;
  /** The middle of the T at the far end. */
  x1: number; z1: number;
  /** Unit direction out to sea. */
  nx: number; nz: number;
  len: number;
}

function outward(I: Island, x: number, z: number): [number, number] {
  const d = 7;
  const gx = islandDist(I, x + d, z) - islandDist(I, x - d, z);
  const gz = islandDist(I, x, z + d) - islandDist(I, x, z - d);
  const l = Math.hypot(gx, gz);
  return l < 1e-6 ? [0, 1] : [gx / l, gz / l];
}

function site(I: Island, sx: number, sz: number): Omit<Pier, 'id' | 'name'> | null {
  if (inTownFootprint(sx, sz, 80)) return null;
  for (const m of MARINAS) if (Math.hypot(m.sx - sx, m.sz - sz) < 250) return null;
  if (!I.mainland && !I.miami && Math.abs(sz - chainZ(sx)) < 45) return null;
  if (creekDist(sx, sz) < 40) return null;
  const [nx, nz] = outward(I, sx, sz);
  // the ground behind: the first point inland that is at deck height (give or take a step)
  let root = -1;
  for (let r = 0; r <= 30; r += 1) {
    const h = landH(sx - nx * r, sz - nz * r);
    if (h > PIER_TOP + 0.45) return null;
    if (h >= PIER_TOP - 0.45) { root = r; break; }
  }
  if (root < 0) return null;
  // out to fishing water, over nothing but water
  let len = -1;
  for (let r = 6; r <= MAX_LEN; r += 3) {
    const x = sx + nx * r, z = sz + nz * r;
    if (landH(x, z) > -0.3) { if (r > 12) return null; continue; }
    if (r >= MIN_LEN && depthAt(x, z) >= FISH_DEPTH) { len = r + 10; break; }
  }
  if (len < 0) return null;
  for (let r = len; r <= len + HEAD_D; r += 2) if (landH(sx + nx * r, sz + nz * r) > -0.3) return null;
  for (let r = -root; r <= len + HEAD_D; r += 3) {
    for (const c of [-HEAD_W / 2, 0, HEAD_W / 2]) if (underBridge(sx + nx * r - nz * c, sz + nz * r + nx * c)) return null;
  }
  return { x0: sx - nx * root, z0: sz - nz * root, x1: sx + nx * len, z1: sz + nz * len, nx, nz, len: len + root };
}

function buildPiers(): Pier[] {
  const town = MARINAS[0];
  const cands: Array<Omit<Pier, 'id' | 'name'> & { d: number; isl: string }> = [];
  for (const I of islands) {
    const ring = I.coast?.rings[0];
    if (!ring || I.miami || I.mainland) continue;
    const m = ring.length / 2;
    for (let i = 0; i < m; i++) {
      // every edge's midpoint, plus a point every 40 m along long edges
      const j = (i + 1) % m;
      const ax = ring[i * 2], az = ring[i * 2 + 1], bx = ring[j * 2], bz = ring[j * 2 + 1];
      const n = Math.max(1, Math.floor(Math.hypot(bx - ax, bz - az) / 40));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        const d = Math.hypot(x - town.sx, z - town.sz);
        if (d > 6000) continue;
        const s = site(I, x, z);
        if (s) cands.push({ ...s, d, isl: I.name });
      }
    }
  }
  cands.sort((a, b) => a.d - b.d);
  const out: Pier[] = [];
  for (const c of cands) {
    if (out.length >= MAX_PIERS) break;
    if (out.some((p) => Math.hypot(p.x1 - c.x1, p.z1 - c.z1) < PIER_SPACING)) continue;
    out.push({ id: `pier-${out.length + 1}`, name: c.isl, x0: c.x0, z0: c.z0, x1: c.x1, z1: c.z1, nx: c.nx, nz: c.nz, len: c.len });
  }
  // Names: "<key> Fishing Pier", or West/East ones where a key has two.
  for (const p of out) {
    const same = out.filter((q) => q.name === p.name);
    const side = same.length < 2 ? '' : p.x0 === Math.min(...same.map((q) => q.x0)) ? 'West ' : p.x0 === Math.max(...same.map((q) => q.x0)) ? 'East ' : 'Middle ';
    (p as { label?: string }).label = `${p.name} ${side}Fishing Pier`;
  }
  return out.map((p) => ({ ...p, name: (p as { label?: string }).label ?? p.name }));
}

export const PIERS: readonly Pier[] = buildPiers();

/** (x,z) in a pier's frame: `a` along it from the root, `c` across it. */
function local(p: Pier, x: number, z: number): [number, number] {
  const dx = x - p.x0, dz = z - p.z0;
  return [dx * p.nx + dz * p.nz, dx * -p.nz + dz * p.nx];
}

/** The pier whose deck is under (x,z), if any (`margin` grows the deck). */
export function pierAt(x: number, z: number, margin = 0): Pier | null {
  for (const p of PIERS) {
    const [a, c] = local(p, x, z);
    if (a < -margin || a > p.len + HEAD_D / 2 + margin) continue;
    const half = a > p.len - HEAD_D / 2 ? HEAD_W / 2 : PIER_W / 2;
    if (Math.abs(c) <= half + margin) return p;
  }
  return null;
}

/** The deck's height under (x,z), or null off every pier. */
export function pierGround(x: number, z: number): number | null {
  return pierAt(x, z) ? PIER_TOP : null;
}

/** The deck point of the nearest pier within `reach` of (x,z), for tying up: like town.ts's `findBerth`. */
export function pierBerth(x: number, z: number, reach: number): { pier: Pier; x: number; z: number; dist: number } | null {
  let best: { pier: Pier; x: number; z: number; dist: number } | null = null;
  for (const p of PIERS) {
    const [a, c] = local(p, x, z);
    const onHead = a > p.len - HEAD_D;
    const half = (onHead ? HEAD_W : PIER_W) / 2 - 0.45;
    const ca = Math.max(4, Math.min(p.len + HEAD_D / 2 - 0.45, a)), cc = Math.max(-half, Math.min(half, c));
    const px = p.x0 + p.nx * ca - p.nz * cc, pz = p.z0 + p.nz * ca + p.nx * cc;
    const dist = Math.hypot(px - x, pz - z);
    if (dist <= reach && (!best || dist < best.dist)) best = { pier: p, x: px, z: pz, dist };
  }
  return best;
}

/** Axis-aligned boxes covering the decks, for the boat's collision (sim/boat.ts DockRect). */
export function pierDockRects(): Array<{ x0: number; x1: number; z0: number; z1: number }> {
  const out: Array<{ x0: number; x1: number; z0: number; z1: number }> = [];
  for (const p of PIERS) {
    const pts = (a: number, c: number): [number, number] => [p.x0 + p.nx * a - p.nz * c, p.z0 + p.nz * a + p.nx * c];
    const box = (a0: number, a1: number, half: number) => {
      const cs = [pts(a0, -half), pts(a0, half), pts(a1, -half), pts(a1, half)];
      out.push({ x0: Math.min(...cs.map((q) => q[0])), x1: Math.max(...cs.map((q) => q[0])), z0: Math.min(...cs.map((q) => q[1])), z1: Math.max(...cs.map((q) => q[1])) });
    };
    for (let a = 0; a < p.len - HEAD_D / 2; a += 3) box(a, Math.min(a + 3, p.len - HEAD_D / 2), PIER_W / 2);
    for (let c = -HEAD_W / 2; c < HEAD_W / 2; c += 3) {
      const cs = [pts(p.len - HEAD_D / 2, c), pts(p.len + HEAD_D / 2, c), pts(p.len - HEAD_D / 2, Math.min(c + 3, HEAD_W / 2)), pts(p.len + HEAD_D / 2, Math.min(c + 3, HEAD_W / 2))];
      out.push({ x0: Math.min(...cs.map((q) => q[0])), x1: Math.max(...cs.map((q) => q[0])), z0: Math.min(...cs.map((q) => q[1])), z1: Math.max(...cs.map((q) => q[1])) });
    }
  }
  return out;
}
