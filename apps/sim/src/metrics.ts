/**
 * /metrics aggregation: players, entities, tick p50/p99 (delegated to World), bytes/s,
 * violations/min, GC pause — docs/ARCHITECTURE.md's metrics list.
 */
import { PerformanceObserver, type PerformanceEntry } from 'node:perf_hooks';
import type { World } from './world/world.js';

class RateCounter {
  private windowMs: number;
  private bucketStartMs: number;
  private sum = 0;
  private lastRate = 0;

  constructor(windowMs: number, nowMs = Date.now()) {
    this.windowMs = windowMs;
    this.bucketStartMs = nowMs;
  }

  record(amount: number, nowMs = Date.now()): void {
    this.rollIfNeeded(nowMs);
    this.sum += amount;
  }

  private rollIfNeeded(nowMs: number): void {
    const elapsed = nowMs - this.bucketStartMs;
    if (elapsed >= this.windowMs) {
      this.lastRate = this.sum / (elapsed / 1000);
      this.sum = 0;
      this.bucketStartMs = nowMs;
    }
  }

  ratePerSec(nowMs = Date.now()): number {
    this.rollIfNeeded(nowMs);
    // Blend the completed window's rate with the in-progress partial window so the number
    // doesn't visibly reset to 0 right after every roll.
    const partialElapsedSec = Math.max(0.001, (nowMs - this.bucketStartMs) / 1000);
    const partialRate = this.sum / partialElapsedSec;
    return partialElapsedSec < 0.25 ? this.lastRate : partialRate;
  }
}

export class GcTracker {
  private pauses: number[] = [];
  private observer: PerformanceObserver;
  private maxSamples = 200;

  constructor() {
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceEntry[]) {
        this.pauses.push(entry.duration);
        if (this.pauses.length > this.maxSamples) this.pauses.shift();
      }
    });
    this.observer.observe({ entryTypes: ['gc'] });
  }

  stop(): void {
    this.observer.disconnect();
  }

  summary(): { count: number; maxMs: number; p99Ms: number } {
    if (this.pauses.length === 0) return { count: 0, maxMs: 0, p99Ms: 0 };
    const sorted = [...this.pauses].sort((a, b) => a - b);
    return {
      count: this.pauses.length,
      maxMs: sorted[sorted.length - 1],
      p99Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))],
    };
  }
}

export class SimMetrics {
  readonly bytesOut = new RateCounter(1000);
  readonly violations = new RateCounter(60_000);
  readonly authRejections = new RateCounter(60_000);
  readonly gc = new GcTracker();

  constructor(private world: World) {}

  recordBytesSent(n: number): void {
    this.bytesOut.record(n);
  }

  recordViolation(): void {
    this.violations.record(1);
  }

  recordAuthRejection(): void {
    this.authRejections.record(1);
  }

  snapshot() {
    return {
      players: this.world.conns.size,
      entities: this.world.entities.activeCount,
      tick: {
        index: this.world.currentTick,
        p50Ms: this.world.tickPercentile(50),
        p99Ms: this.world.tickPercentile(99),
        lastAtMs: this.world.lastTickTimestampMs,
      },
      bytesOutPerSec: this.bytesOut.ratePerSec(),
      violationsPerMin: this.violations.ratePerSec() * 60,
      violationsTotal: this.world.totalViolations,
      simBehind: this.world.simBehind,
      authRejectionsPerMin: this.authRejections.ratePerSec() * 60,
      gridCells: this.world.grid.cellCount,
      gc: this.gc.summary(),
    };
  }

  stop(): void {
    this.gc.stop();
  }
}
