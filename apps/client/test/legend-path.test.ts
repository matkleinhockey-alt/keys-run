/**
 * The gold bluefin are a fact about the world: where they are depends on the wall clock and the
 * seed and on nothing else. Before, `stepSchool` advanced them on session time, so two players an
 * hour apart saw them in different places. This pins (a) agreement between independent
 * evaluations, (b) that the continuous path never leaves water they can live in, and (c) that
 * it is actually a wander across the chart rather than a circle round one spot.
 */
import { describe, expect, it } from 'vitest';
import { legendPoseAt, legendLoopLength, LEGEND_MIN_DEPTH, LEGEND_MIN_SHORE } from '../src/entities/fish/legend-path.js';
import { depthAt, WB } from '@keysrun/shared/world/depth';
import { shoreInfo } from '@keysrun/shared/world/chain';
import { VIS } from '@keysrun/shared/content/creatures';
import { WORLD_SEED } from '../src/state/constants.js';

const DMIN = Math.max(VIS.goldbluefin.dMin, LEGEND_MIN_DEPTH);
/** Fixed instant so the test is the same every day (a real clock would only add flakiness). */
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
const DAY = 24 * 3600_000;
const pose = (ms: number) => legendPoseAt(WORLD_SEED, ms, VIS.goldbluefin.dMin)!;

describe('legend path', () => {
  it('is a pure function of the wall clock', () => {
    for (let k = 0; k < 50; k++) {
      const ms = T0 + k * 7_919_000;
      expect(legendPoseAt(WORLD_SEED, ms, VIS.goldbluefin.dMin)).toEqual(pose(ms));
    }
    // A different world puts them somewhere else.
    expect(legendPoseAt(WORLD_SEED + 1, T0, VIS.goldbluefin.dMin)).not.toEqual(pose(T0));
  });

  it('stays in legal water for 24 simulated hours', () => {
    let minDepth = 1e9, minShore = 1e9;
    for (let ms = T0; ms < T0 + DAY; ms += 5_000) {
      const p = pose(ms);
      expect(p.x).toBeGreaterThanOrEqual(WB.x0); expect(p.x).toBeLessThanOrEqual(WB.x1);
      expect(p.z).toBeGreaterThanOrEqual(WB.z0); expect(p.z).toBeLessThanOrEqual(WB.z1);
      minDepth = Math.min(minDepth, depthAt(p.x, p.z));
      minShore = Math.min(minShore, shoreInfo(p.x, p.z).d);
    }
    expect(minDepth).toBeGreaterThanOrEqual(DMIN);
    expect(minShore).toBeGreaterThanOrEqual(LEGEND_MIN_SHORE);
  });

  it('moves continuously: no teleport between samples', () => {
    let prev = pose(T0), worst = 0;
    for (let ms = T0 + 1000; ms < T0 + DAY; ms += 1000) {
      const p = pose(ms);
      worst = Math.max(worst, Math.hypot(p.x - prev.x, p.z - prev.z));
      prev = p;
    }
    expect(worst).toBeLessThan(VIS.goldbluefin.speed);
  });

  it('covers a spread of the chart over a day, not one spot', () => {
    const cells = new Set<string>();
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (let ms = T0; ms < T0 + DAY; ms += 60_000) {
      const p = pose(ms);
      cells.add(`${Math.floor(p.x / 500)},${Math.floor(p.z / 500)}`);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    expect(legendLoopLength(WORLD_SEED, VIS.goldbluefin.dMin)).toBeGreaterThan(10_000);
    expect(maxX - minX).toBeGreaterThan(5000);
    expect(maxZ - minZ).toBeGreaterThan(2500); // legal water is a ~3.7 km band (z 1550..5250): the Atlantic side
    expect(cells.size).toBeGreaterThan(20);
  });
});
