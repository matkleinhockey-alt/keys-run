/**
 * Sparse 64 m interest grid + per-connection subscription hysteresis — docs/ARCHITECTURE.md's
 * "Interest management". `InterestGrid` is the `Map<int32, Set<entityId>>` the doc names
 * directly; `evaluateInterest` re-evaluates one player's subscription set (called at ~4 Hz,
 * staggered across players by slot — see world.ts) and `tierOf`/snapshot.ts decide broadcast
 * rate per subscribed entity (hot/mid/far), not subscribe/unsubscribe — the subscribe boundary
 * itself is the single 260 m radius with 1.15x/2s hysteresis the doc specifies; hot/mid/far only
 * select how often an *already-subscribed* entity is refreshed.
 */
import {
  GRID_CELL_M,
  MIN_DWELL_MS,
  RADIUS_FAR_M,
  RADIUS_HOT_M,
  RADIUS_MID_M,
  UNSUBSCRIBE_FACTOR,
} from '../constants.js';

export const TIER_HOT = 0;
export const TIER_MID = 1;
export const TIER_FAR = 2;
export type Tier = typeof TIER_HOT | typeof TIER_MID | typeof TIER_FAR;

export function tierOf(distanceM: number): Tier {
  if (distanceM <= RADIUS_HOT_M) return TIER_HOT;
  if (distanceM <= RADIUS_MID_M) return TIER_MID;
  return TIER_FAR;
}

const CELL_OFFSET = 1 << 13; // 8192 — comfortably covers the world's ~[-70,100] cell-coordinate range

/** Pack (cx,cz) into one non-negative int32 Map key. Allocation-free (plain number). */
export function cellKeyOf(cx: number, cz: number): number {
  return ((cx + CELL_OFFSET) << 16) | (cz + CELL_OFFSET);
}

export class InterestGrid {
  private cells = new Map<number, Set<number>>();

  insert(entityId: number, cx: number, cz: number): void {
    const key = cellKeyOf(cx, cz);
    let set = this.cells.get(key);
    if (!set) {
      set = new Set();
      this.cells.set(key, set);
    }
    set.add(entityId);
  }

  remove(entityId: number, cx: number, cz: number): void {
    const key = cellKeyOf(cx, cz);
    const set = this.cells.get(key);
    if (!set) return;
    set.delete(entityId);
    if (set.size === 0) this.cells.delete(key);
  }

  move(entityId: number, oldCx: number, oldCz: number, newCx: number, newCz: number): void {
    if (oldCx === newCx && oldCz === newCz) return;
    this.remove(entityId, oldCx, oldCz);
    this.insert(entityId, newCx, newCz);
  }

  /** Collect candidate entity ids within Chebyshev `radiusCells` of (cx,cz) into `out` (cleared first). */
  queryInto(cx: number, cz: number, radiusCells: number, out: Set<number>): void {
    out.clear();
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      for (let dz = -radiusCells; dz <= radiusCells; dz++) {
        const set = this.cells.get(cellKeyOf(cx + dx, cz + dz));
        if (set) for (const id of set) out.add(id);
      }
    }
  }

  get cellCount(): number {
    return this.cells.size;
  }
}

export interface SubscriptionInfo {
  tier: Tier;
  subscribedAtMs: number;
}

export interface EvaluateInterestParams {
  selfEntityId: number;
  selfX: number;
  selfZ: number;
  grid: InterestGrid;
  /** (entityId) => {x,z} | null (null if the entity no longer exists). */
  positionOf: (entityId: number) => { x: number; z: number } | null;
  /** Mutated in place. */
  subscriptions: Map<number, SubscriptionInfo>;
  nowMs: number;
  /** Reused scratch Set — avoids allocating a new Set every evaluation. */
  scratchCandidates: Set<number>;
  /** Cleared (length=0) by the caller before calling; entityIds newly subscribed are pushed here. */
  enteredOut: number[];
  /** Cleared (length=0) by the caller before calling; entityIds unsubscribed are pushed here. */
  leftOut: number[];
}

const SCAN_RADIUS_CELLS = Math.ceil((RADIUS_FAR_M * UNSUBSCRIBE_FACTOR) / GRID_CELL_M) + 1;

export function evaluateInterest(p: EvaluateInterestParams): void {
  const unsubscribeAt = RADIUS_FAR_M * UNSUBSCRIBE_FACTOR;

  // Step 1: re-check every existing subscription directly (correct regardless of scan radius —
  // an entity that moved far away in one jump is still found and dropped).
  for (const [entityId, info] of p.subscriptions) {
    const pos = p.positionOf(entityId);
    if (!pos) {
      p.subscriptions.delete(entityId);
      p.leftOut.push(entityId);
      continue;
    }
    const dist = Math.hypot(pos.x - p.selfX, pos.z - p.selfZ);
    if (dist > unsubscribeAt && p.nowMs - info.subscribedAtMs >= MIN_DWELL_MS) {
      p.subscriptions.delete(entityId);
      p.leftOut.push(entityId);
      continue;
    }
    info.tier = tierOf(dist);
  }

  // Step 2: scan the grid for new candidates within the subscribe radius.
  const cx = Math.floor(p.selfX / GRID_CELL_M);
  const cz = Math.floor(p.selfZ / GRID_CELL_M);
  p.grid.queryInto(cx, cz, SCAN_RADIUS_CELLS, p.scratchCandidates);

  for (const entityId of p.scratchCandidates) {
    if (entityId === p.selfEntityId) continue;
    if (p.subscriptions.has(entityId)) continue;
    const pos = p.positionOf(entityId);
    if (!pos) continue;
    const dist = Math.hypot(pos.x - p.selfX, pos.z - p.selfZ);
    if (dist > RADIUS_FAR_M) continue;
    p.subscriptions.set(entityId, { tier: tierOf(dist), subscribedAtMs: p.nowMs });
    p.enteredOut.push(entityId);
  }
}
