/**
 * Builds the per-player-filtered SNAPSHOT payload: spawns/despawns accumulated since the last
 * broadcast, then subscribed boats gated by tier rate (hot every broadcast, mid every 2nd, far
 * every 4th — docs/ARCHITECTURE.md's "Ring rates") and a priority accumulator against a
 * per-client byte budget (closer = higher priority; see docs/ARCHITECTURE.md's "Budget").
 *
 * Note (flagged in the Phase 2 handoff report): this encodes *absolute* quantized x/z/h/speed
 * per boat, not delta-against-acknowledged-baseline. At Phase 2's boat-only entity density the
 * absolute encoding comfortably meets the ~3-4 KB/s steady-state budget (measured in
 * test/load.ts), so the desync-avoiding "delta against last ack, never against the previous
 * packet" compression docs/ARCHITECTURE.md's netcode section describes is not implemented here —
 * `ackTick` is still tracked per connection (ConnMeta.ackTick) for this future work and for
 * visibility in /metrics, but nothing currently reads it to build a delta.
 */
import type { ConnMeta } from '../world/connection.js';
import type { BoatEntities } from '../world/entities.js';
import { TIER_FAR, TIER_HOT, TIER_MID } from '../world/interest.js';
import { FAR_TIER_SNAPSHOT_DIVISOR, HARD_CAP_BYTES_PER_SNAPSHOT, MID_TIER_SNAPSHOT_DIVISOR } from '../constants.js';
import type { SnapshotMsg } from '@keysrun/shared/proto';

// Conservative, rounded-up per-entry byte costs (see schema.ts's exact bit widths) used only to
// decide inclusion order before the real bit-level encode — a few bytes of slack either way is
// fine against the hard cap.
const BOAT_ENTRY_BYTES = 9;
const SPAWN_ENTRY_BYTES = 8;
const DESPAWN_ENTRY_BYTES = 2;

interface Candidate {
  entityId: number;
  distSq: number;
}

export function buildSnapshot(params: {
  tick: number;
  conn: ConnMeta;
  entities: BoatEntities;
  /** Increments once per broadcast (every SNAPSHOT_TICKS ticks) — gates mid/far inclusion rate. */
  snapshotCounter: number;
  /** Scratch array reused across calls to avoid allocating a new one every broadcast. */
  scratchCandidates: Candidate[];
}): SnapshotMsg {
  const { conn, entities, snapshotCounter, scratchCandidates } = params;

  const spawns = conn.enteredSinceSnapshot.map((entityId) => ({
    slotId: entityId,
    hullIndex: entities.hullIndex[entityId],
    x: entities.x[entityId],
    z: entities.z[entityId],
    h: entities.h[entityId],
  }));
  const despawns = conn.leftSinceSnapshot.map((entityId) => ({ slotId: entityId }));
  conn.enteredSinceSnapshot.length = 0;
  conn.leftSinceSnapshot.length = 0;

  let budget = HARD_CAP_BYTES_PER_SNAPSHOT - spawns.length * SPAWN_ENTRY_BYTES - despawns.length * DESPAWN_ENTRY_BYTES;

  scratchCandidates.length = 0;
  const selfX = entities.x[conn.slot];
  const selfZ = entities.z[conn.slot];
  for (const [entityId, info] of conn.subscriptions) {
    if (!entities.used[entityId]) continue;
    const dueThisTick =
      info.tier === TIER_HOT ||
      (info.tier === TIER_MID && snapshotCounter % MID_TIER_SNAPSHOT_DIVISOR === 0) ||
      (info.tier === TIER_FAR && snapshotCounter % FAR_TIER_SNAPSHOT_DIVISOR === 0);
    if (!dueThisTick) continue;
    const dx = entities.x[entityId] - selfX;
    const dz = entities.z[entityId] - selfZ;
    scratchCandidates.push({ entityId, distSq: dx * dx + dz * dz });
  }
  // Priority accumulator: closest first, until the byte budget runs out.
  scratchCandidates.sort((a, b) => a.distSq - b.distSq);

  const boats: SnapshotMsg['boats'] = [];
  for (const c of scratchCandidates) {
    if (budget < BOAT_ENTRY_BYTES) break;
    budget -= BOAT_ENTRY_BYTES;
    const id = c.entityId;
    boats.push({
      slotId: id,
      x: entities.x[id],
      z: entities.z[id],
      h: entities.h[id],
      speed: entities.speed[id],
      corrected: entities.correctedSinceSnapshot[id] === 1,
    });
  }

  return { tick: params.tick, spawns, despawns, boats };
}
