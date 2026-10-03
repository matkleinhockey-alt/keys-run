import { describe, expect, it } from 'vitest';
import { cellKeyOf, evaluateInterest, InterestGrid, TIER_FAR, TIER_HOT, TIER_MID, tierOf } from '../src/world/interest.js';
import { GRID_CELL_M, MIN_DWELL_MS, RADIUS_FAR_M, RADIUS_HOT_M, RADIUS_MID_M, UNSUBSCRIBE_FACTOR } from '../src/constants.js';

describe('InterestGrid', () => {
  it('cellKeyOf is injective over a realistic coordinate range', () => {
    const seen = new Set<number>();
    for (let cx = -100; cx <= 100; cx++) {
      for (let cz = -80; cz <= 80; cz += 4) {
        const key = cellKeyOf(cx, cz);
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it('insert/remove/move keep cell membership correct', () => {
    const grid = new InterestGrid();
    grid.insert(1, 0, 0);
    grid.insert(2, 0, 0);
    grid.insert(3, 5, 5);

    const out = new Set<number>();
    grid.queryInto(0, 0, 0, out);
    expect(out).toEqual(new Set([1, 2]));

    grid.move(1, 0, 0, 5, 5);
    const out2 = new Set<number>();
    grid.queryInto(0, 0, 0, out2);
    expect(out2).toEqual(new Set([2]));

    const out3 = new Set<number>();
    grid.queryInto(5, 5, 0, out3);
    expect(out3).toEqual(new Set([1, 3]));

    grid.remove(2, 0, 0);
    expect(grid.cellCount).toBe(1); // only the (5,5) cell remains occupied
  });

  it('queryInto with a radius finds entities in neighboring cells', () => {
    const grid = new InterestGrid();
    grid.insert(42, 10, 10);
    const out = new Set<number>();
    grid.queryInto(9, 9, 1, out);
    expect(out.has(42)).toBe(true);
    const outFar = new Set<number>();
    grid.queryInto(0, 0, 1, outFar);
    expect(outFar.has(42)).toBe(false);
  });
});

describe('tierOf', () => {
  it('buckets distance into hot/mid/far at the documented thresholds', () => {
    expect(tierOf(0)).toBe(TIER_HOT);
    expect(tierOf(RADIUS_HOT_M)).toBe(TIER_HOT);
    expect(tierOf(RADIUS_HOT_M + 0.01)).toBe(TIER_MID);
    expect(tierOf(RADIUS_MID_M)).toBe(TIER_MID);
    expect(tierOf(RADIUS_MID_M + 0.01)).toBe(TIER_FAR);
    expect(tierOf(RADIUS_FAR_M)).toBe(TIER_FAR);
    expect(tierOf(RADIUS_FAR_M + 100)).toBe(TIER_FAR);
  });
});

describe('evaluateInterest', () => {
  function positions(map: Map<number, { x: number; z: number }>) {
    return (id: number) => map.get(id) ?? null;
  }

  it('subscribes to a new entity that enters the subscribe radius', () => {
    const grid = new InterestGrid();
    const posMap = new Map<number, { x: number; z: number }>([[2, { x: 100, z: 0 }]]);
    grid.insert(2, Math.floor(100 / GRID_CELL_M), 0);

    const subscriptions = new Map();
    const entered: number[] = [];
    const left: number[] = [];
    evaluateInterest({
      selfEntityId: 1,
      selfX: 0,
      selfZ: 0,
      grid,
      positionOf: positions(posMap),
      subscriptions,
      nowMs: 1000,
      scratchCandidates: new Set(),
      enteredOut: entered,
      leftOut: left,
    });

    expect(entered).toEqual([2]);
    expect(left).toEqual([]);
    expect(subscriptions.get(2)?.tier).toBe(TIER_FAR); // 100m is beyond the mid radius (80m)
  });

  it('does not subscribe to an entity beyond the far radius', () => {
    const grid = new InterestGrid();
    const posMap = new Map<number, { x: number; z: number }>([[2, { x: 1000, z: 0 }]]);
    grid.insert(2, Math.floor(1000 / GRID_CELL_M), 0);

    const subscriptions = new Map();
    const entered: number[] = [];
    evaluateInterest({
      selfEntityId: 1,
      selfX: 0,
      selfZ: 0,
      grid,
      positionOf: positions(posMap),
      subscriptions,
      nowMs: 1000,
      scratchCandidates: new Set(),
      enteredOut: entered,
      leftOut: [],
    });

    expect(entered).toEqual([]);
    expect(subscriptions.size).toBe(0);
  });

  it('does not unsubscribe an in-hysteresis-band entity before the minimum dwell elapses', () => {
    const grid = new InterestGrid();
    const posMap = new Map<number, { x: number; z: number }>([[2, { x: 50, z: 0 }]]);
    grid.insert(2, 0, 0);
    const subscriptions = new Map([[2, { tier: TIER_MID, subscribedAtMs: 1000 }]]);

    // Entity moves beyond the far radius (but within the 1.15x hysteresis band) shortly after subscribing.
    posMap.set(2, { x: RADIUS_FAR_M + 10, z: 0 });
    const left: number[] = [];
    evaluateInterest({
      selfEntityId: 1,
      selfX: 0,
      selfZ: 0,
      grid,
      positionOf: positions(posMap),
      subscriptions,
      nowMs: 1000 + MIN_DWELL_MS - 100, // just under the dwell minimum
      scratchCandidates: new Set(),
      enteredOut: [],
      leftOut: left,
    });

    expect(left).toEqual([]);
    expect(subscriptions.has(2)).toBe(true);
  });

  it('unsubscribes once beyond unsubscribeAt and the dwell has elapsed', () => {
    const grid = new InterestGrid();
    const posMap = new Map<number, { x: number; z: number }>([[2, { x: RADIUS_FAR_M * UNSUBSCRIBE_FACTOR + 10, z: 0 }]]);
    const subscriptions = new Map([[2, { tier: TIER_FAR, subscribedAtMs: 1000 }]]);
    const left: number[] = [];
    evaluateInterest({
      selfEntityId: 1,
      selfX: 0,
      selfZ: 0,
      grid,
      positionOf: positions(posMap),
      subscriptions,
      nowMs: 1000 + MIN_DWELL_MS + 1,
      scratchCandidates: new Set(),
      enteredOut: [],
      leftOut: left,
    });

    expect(left).toEqual([2]);
    expect(subscriptions.has(2)).toBe(false);
  });

  it('never pops: an entity sitting exactly at the subscribe radius does not flap in/out across repeated evaluations', () => {
    const grid = new InterestGrid();
    const x = RADIUS_FAR_M - 0.01; // just inside
    const posMap = new Map<number, { x: number; z: number }>([[2, { x, z: 0 }]]);
    grid.insert(2, Math.floor(x / GRID_CELL_M), 0);
    const subscriptions = new Map();
    let now = 0;

    for (let i = 0; i < 20; i++) {
      now += 50;
      evaluateInterest({
        selfEntityId: 1,
        selfX: 0,
        selfZ: 0,
        grid,
        positionOf: positions(posMap),
        subscriptions,
        nowMs: now,
        scratchCandidates: new Set(),
        enteredOut: [],
        leftOut: [],
      });
    }
    // Once subscribed (just inside the radius), hysteresis keeps it subscribed even though the
    // tier boundary itself (far) is right at the edge — no flapping.
    expect(subscriptions.has(2)).toBe(true);
  });
});
