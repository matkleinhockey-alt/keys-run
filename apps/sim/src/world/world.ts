/**
 * The authoritative world: owns the SoA entity storage, the per-connection shadow/envelope/
 * leash reconciliation, and the interest grid. Transport-agnostic (see connection.ts) — nothing
 * here touches `ws` directly, which is what makes envelope/interest/tick behaviour unit-testable
 * without a real socket (see apps/sim/test/envelope.test.ts, interest.test.ts, world.test.ts).
 *
 * `tick()` is docs/ARCHITECTURE.md's fixed-timestep body: step the shadow model for every
 * connection, reconcile against its self-report, update the interest grid, stagger interest
 * re-evaluation across connections by slot. It also times itself (p50/p99 ring buffer) — see
 * `tickStats`.
 */
import { createShadowState, stepBoatShadow } from '@keysrun/shared/sim/boat-shadow';
import type { BoatHull } from '@keysrun/shared/sim/boat';
import { DEFAULT_CH, DEFAULT_SW } from '@keysrun/shared/waves';
import { BoatEntities } from './entities.js';
import { applyInputMessage, createConnMeta, type ConnMeta } from './connection.js';
import { InterestGrid, evaluateInterest } from './interest.js';
import { reconcileBoat } from './envelope.js';
import { DT, INTEREST_EVAL_TICKS } from '../constants.js';

export interface Spawn {
  x: number;
  z: number;
  h: number;
  speed: number;
}

export interface ConnectResult {
  slot: number;
  tick: number;
  hullIndex: number;
  x: number;
  z: number;
  h: number;
  speed: number;
}

const TICK_HISTORY_SIZE = 600; // 20s at 30Hz — enough for stable p50/p99

export class World {
  readonly entities: BoatEntities;
  readonly grid = new InterestGrid();
  readonly conns = new Map<number, ConnMeta>();

  private hullOf: (hullIndex: number) => BoatHull;
  private tickIndex = 0;
  private simTimeSec = 0;
  private tickDurationsMs = new Float64Array(TICK_HISTORY_SIZE);
  private tickHistoryIndex = 0;
  private tickHistoryCount = 0;
  private lastTickAtMs = 0;
  totalViolations = 0;
  totalTicks = 0;
  /** Count of accumulator polls that still had >= DT backlog after MAX_STEPS_PER_FRAME steps — dropped, not caught up. */
  simBehind = 0;

  constructor(capacity: number, hullOf: (hullIndex: number) => BoatHull) {
    this.entities = new BoatEntities(capacity);
    this.hullOf = hullOf;
  }

  get currentTick(): number {
    return this.tickIndex;
  }

  connectPlayer(userId: string, hullIndex: number, spawn: Spawn, send: (bytes: Uint8Array) => void, nowMs: number): ConnectResult | null {
    const slot = this.entities.alloc();
    if (slot === null) return null;
    this.entities.spawn(slot, userId, hullIndex, spawn.x, spawn.z, spawn.h, spawn.speed);
    this.grid.insert(slot, this.entities.gridCx[slot], this.entities.gridCz[slot]);
    const conn = createConnMeta(slot, userId, send, nowMs);
    conn.input.x = spawn.x;
    conn.input.z = spawn.z;
    conn.input.h = spawn.h;
    conn.input.speed = spawn.speed;
    this.conns.set(slot, conn);
    return { slot, tick: this.tickIndex, hullIndex, x: spawn.x, z: spawn.z, h: spawn.h, speed: spawn.speed };
  }

  disconnectPlayer(slot: number): void {
    const conn = this.conns.get(slot);
    if (!conn) return;
    this.grid.remove(slot, this.entities.gridCx[slot], this.entities.gridCz[slot]);
    this.conns.delete(slot);
    this.entities.free(slot);
  }

  onInput(
    slot: number,
    msg: {
      seq: number;
      ackTick: number;
      fwd: boolean;
      back: boolean;
      left: boolean;
      right: boolean;
      trimUp: boolean;
      trimDn: boolean;
      x: number;
      z: number;
      h: number;
      speed: number;
    },
    nowMs: number,
  ): void {
    const conn = this.conns.get(slot);
    if (!conn) return;
    applyInputMessage(conn, msg, nowMs);
  }

  /** Advance the world by exactly one fixed DT step. */
  tick(nowMs: number): void {
    const startedAt = performance.now();
    this.simTimeSec += DT;

    for (const [slot, conn] of this.conns) {
      const hull = this.hullOf(this.entities.hullIndex[slot]);
      const input = conn.input;

      const shadowState = this.entities.readShadow(slot);
      const nextShadow = stepBoatShadow(shadowState, input, { t: this.simTimeSec, hull, sw: DEFAULT_SW, ch: DEFAULT_CH }, DT);

      const result = reconcileBoat({
        prevX: this.entities.lastReportX[slot],
        prevZ: this.entities.lastReportZ[slot],
        prevH: this.entities.lastReportH[slot],
        prevSpeed: this.entities.lastReportSpeed[slot],
        reportX: input.x,
        reportZ: input.z,
        reportH: input.h,
        reportSpeed: input.speed,
        shadow: nextShadow,
        hull,
        dt: DT,
      });

      this.entities.x[slot] = result.x;
      this.entities.z[slot] = result.z;
      this.entities.h[slot] = result.h;
      this.entities.speed[slot] = result.speed;
      this.entities.writeShadow(slot, result.newShadow);
      this.entities.lastReportX[slot] = input.x;
      this.entities.lastReportZ[slot] = input.z;
      this.entities.lastReportH[slot] = input.h;
      this.entities.lastReportSpeed[slot] = input.speed;

      if (result.violated) {
        this.entities.violationScore[slot] += 1;
        this.totalViolations++;
      }
      if (result.corrected) {
        this.entities.correctedSinceSnapshot[slot] = 1;
      }

      const newCx = Math.floor(result.x / 64);
      const newCz = Math.floor(result.z / 64);
      if (newCx !== this.entities.gridCx[slot] || newCz !== this.entities.gridCz[slot]) {
        this.grid.move(slot, this.entities.gridCx[slot], this.entities.gridCz[slot], newCx, newCz);
        this.entities.gridCx[slot] = newCx;
        this.entities.gridCz[slot] = newCz;
      }

      conn.hasNewInput = false;
      conn.dirty = true;

      if (this.tickIndex % INTEREST_EVAL_TICKS === slot % INTEREST_EVAL_TICKS) {
        evaluateInterest({
          selfEntityId: slot,
          selfX: result.x,
          selfZ: result.z,
          grid: this.grid,
          positionOf: (id) => (this.entities.used[id] ? { x: this.entities.x[id], z: this.entities.z[id] } : null),
          subscriptions: conn.subscriptions,
          nowMs,
          scratchCandidates: conn.scratchCandidates,
          enteredOut: conn.enteredSinceSnapshot,
          leftOut: conn.leftSinceSnapshot,
        });
      }
    }

    this.tickIndex++;
    this.totalTicks++;
    this.lastTickAtMs = nowMs;
    const durationMs = performance.now() - startedAt;
    this.tickDurationsMs[this.tickHistoryIndex] = durationMs;
    this.tickHistoryIndex = (this.tickHistoryIndex + 1) % TICK_HISTORY_SIZE;
    this.tickHistoryCount = Math.min(TICK_HISTORY_SIZE, this.tickHistoryCount + 1);
  }

  /** Clear the "just corrected" flag on every entity — called once per broadcast cycle, after all connections' snapshots are built. */
  clearCorrectedFlags(): void {
    this.entities.correctedSinceSnapshot.fill(0);
  }

  get lastTickTimestampMs(): number {
    return this.lastTickAtMs;
  }

  tickPercentile(p: number): number {
    const n = this.tickHistoryCount;
    if (n === 0) return 0;
    const sorted = Array.from(this.tickDurationsMs.subarray(0, n)).sort((a, b) => a - b);
    const idx = Math.min(n - 1, Math.floor((p / 100) * n));
    return sorted[idx];
  }

  static createShadowFor(x: number, z: number, h: number) {
    return createShadowState(x, z, h);
  }
}
