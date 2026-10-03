/**
 * Structure-of-arrays storage for every connected player's boat. Per docs/ARCHITECTURE.md's
 * "zero allocation in the steady-state tick": every per-tick numeric field lives in a
 * preallocated typed array indexed by slot id, never in a per-entity object. Slot ids are the
 * 9-bit id space docs/ARCHITECTURE.md's netcode section calls for ("per-client 9-bit slot ids
 * rather than global 16-bit ids") — here used directly as the *global* entity id too, which is
 * a deliberate Phase 2 simplification: with boats as the only entity kind and a hard cap in the
 * low hundreds, there's no need yet for the separate per-connection remapping a much larger
 * (post-boats, post-fish) entity population would eventually require. Flagged in the handoff
 * report.
 *
 * Non-numeric per-slot bookkeeping (the live `ws` connection, subscription sets, pending input
 * objects) is *not* SoA — those are allocated once per connection (at connect time, not per
 * tick) and live in `ConnMeta` (see world.ts), which is the intentional boundary of "zero
 * allocation" here: steady-state *ticking* an existing connection touches only typed arrays.
 */
import type { BoatHull } from '@keysrun/shared/sim/boat';
import type { ShadowBoatState } from '@keysrun/shared/sim/boat-shadow';

export const GEAR_D = 0;
export const GEAR_N = 1;
export const GEAR_R = 2;

export class BoatEntities {
  readonly capacity: number;

  readonly used: Uint8Array;
  readonly userIdOfSlot: (string | null)[];
  readonly hullIndex: Uint8Array;

  // Replicated (authoritative-for-other-clients) state.
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly h: Float64Array;
  readonly speed: Float64Array;

  // Shadow model state (server's independent 2-DOF estimate).
  readonly shadowX: Float64Array;
  readonly shadowZ: Float64Array;
  readonly shadowH: Float64Array;
  readonly shadowSpeed: Float64Array;
  readonly shadowThr: Float64Array;
  readonly shadowSteer: Float64Array;
  readonly shadowGear: Uint8Array;

  // Last accepted client self-report (for envelope delta checks against the next report).
  readonly lastReportX: Float64Array;
  readonly lastReportZ: Float64Array;
  readonly lastReportH: Float64Array;
  readonly lastReportSpeed: Float64Array;

  // Interest grid bookkeeping.
  readonly gridCx: Int32Array;
  readonly gridCz: Int32Array;

  readonly violationScore: Float32Array;
  /** Set when a correction happened since the last broadcast cycle; cleared by World after each broadcast. */
  readonly correctedSinceSnapshot: Uint8Array;

  private freeList: number[] = [];

  constructor(capacity: number) {
    this.capacity = capacity;
    this.used = new Uint8Array(capacity);
    this.userIdOfSlot = new Array(capacity).fill(null);
    this.hullIndex = new Uint8Array(capacity);

    this.x = new Float64Array(capacity);
    this.z = new Float64Array(capacity);
    this.h = new Float64Array(capacity);
    this.speed = new Float64Array(capacity);

    this.shadowX = new Float64Array(capacity);
    this.shadowZ = new Float64Array(capacity);
    this.shadowH = new Float64Array(capacity);
    this.shadowSpeed = new Float64Array(capacity);
    this.shadowThr = new Float64Array(capacity);
    this.shadowSteer = new Float64Array(capacity);
    this.shadowGear = new Uint8Array(capacity);

    this.lastReportX = new Float64Array(capacity);
    this.lastReportZ = new Float64Array(capacity);
    this.lastReportH = new Float64Array(capacity);
    this.lastReportSpeed = new Float64Array(capacity);

    this.gridCx = new Int32Array(capacity);
    this.gridCz = new Int32Array(capacity);

    this.violationScore = new Float32Array(capacity);
    this.correctedSinceSnapshot = new Uint8Array(capacity);

    for (let i = capacity - 1; i >= 0; i--) this.freeList.push(i);
  }

  /** Allocate a slot (connect time only — not in the steady-state tick). Returns null if full. */
  alloc(): number | null {
    const slot = this.freeList.pop();
    if (slot === undefined) return null;
    this.used[slot] = 1;
    return slot;
  }

  /** Release a slot (disconnect time only). */
  free(slot: number): void {
    this.used[slot] = 0;
    this.userIdOfSlot[slot] = null;
    this.violationScore[slot] = 0;
    this.freeList.push(slot);
  }

  get activeCount(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) n += this.used[i];
    return n;
  }

  spawn(slot: number, userId: string, hullIndex: number, x: number, z: number, h: number, speed: number): void {
    this.userIdOfSlot[slot] = userId;
    this.hullIndex[slot] = hullIndex;
    this.x[slot] = x;
    this.z[slot] = z;
    this.h[slot] = h;
    this.speed[slot] = speed;
    this.shadowX[slot] = x;
    this.shadowZ[slot] = z;
    this.shadowH[slot] = h;
    this.shadowSpeed[slot] = speed;
    this.shadowThr[slot] = 0;
    this.shadowSteer[slot] = 0;
    this.shadowGear[slot] = GEAR_D;
    this.lastReportX[slot] = x;
    this.lastReportZ[slot] = z;
    this.lastReportH[slot] = h;
    this.lastReportSpeed[slot] = speed;
    this.gridCx[slot] = Math.floor(x / 64);
    this.gridCz[slot] = Math.floor(z / 64);
    this.violationScore[slot] = 0;
    this.correctedSinceSnapshot[slot] = 0;
  }

  readShadow(slot: number): ShadowBoatState {
    return {
      x: this.shadowX[slot],
      z: this.shadowZ[slot],
      h: this.shadowH[slot],
      speed: this.shadowSpeed[slot],
      thr: this.shadowThr[slot],
      steer: this.shadowSteer[slot],
      gear: this.shadowGear[slot] === GEAR_D ? 'D' : this.shadowGear[slot] === GEAR_N ? 'N' : 'R',
    };
  }

  writeShadow(slot: number, s: ShadowBoatState): void {
    this.shadowX[slot] = s.x;
    this.shadowZ[slot] = s.z;
    this.shadowH[slot] = s.h;
    this.shadowSpeed[slot] = s.speed;
    this.shadowThr[slot] = s.thr;
    this.shadowSteer[slot] = s.steer;
    this.shadowGear[slot] = s.gear === 'D' ? GEAR_D : s.gear === 'N' ? GEAR_N : GEAR_R;
  }
}

export interface HullTable {
  (hullIndex: number): BoatHull;
}
