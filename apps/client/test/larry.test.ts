/**
 * Larry's POS: that his drift loops are water a raft can actually be on, that he is sometimes
 * out and sometimes not, and that he is genuinely slow.
 */
import { describe, it, expect } from 'vitest';
import { driftLoop, LARRY_LOOPS, larryAt, RAFT_DRAFT_M } from '../src/entities/life/larry.js';
import { depthAt, landH, WB } from '@keysrun/shared/world/depth';

const LOOPS = LARRY_LOOPS.map(([x, z, r]) => driftLoop(x, z, r));

describe("Larry's drift loops", () => {
  it('each survive the water filter with a usable loop left', () => {
    // driftLoop drops points rather than nudging them, so a badly placed centre can come back as
    // three points and a straight line. Each loop starts from 28 samples.
    LOOPS.forEach((L, i) => {
      expect(L.total, `loop ${i} length`).toBeGreaterThan(900);
    });
  });

  it('never put the raft on the bottom or on the beach', () => {
    // Checked ALONG the route, not at the sample points. The path is a polyline through them,
    // so a loop whose every sample cleared 1.3 m measured 0.63 m on the leg between two of them.
    // Only walking it finds that.
    LOOPS.forEach((L, i) => {
      for (let s = 0; s < L.total; s += 8) {
        const P = L.at(s);
        expect(landH(P.x, P.z), `loop ${i} on land at s=${s.toFixed(0)}`).toBeLessThanOrEqual(0.02);
        expect(depthAt(P.x, P.z), `loop ${i} aground at s=${s.toFixed(0)}`).toBeGreaterThan(RAFT_DRAFT_M + 0.1);
      }
    });
  });

  it('are mostly water the player can follow him into', () => {
    // He is allowed to cut through skinny water your boat cannot — that is the point of a raft.
    // But if a whole loop sat up on the flats you could never get near enough for the gag.
    LOOPS.forEach((L, i) => {
      let n = 0, deep = 0;
      for (let s = 0; s < L.total; s += 8) { n++; if (depthAt(L.at(s).x, L.at(s).z) > 1.2) deep++; }
      expect(deep / n, `loop ${i} navigable fraction`).toBeGreaterThan(0.7);
    });
  });

  it('stay inside the box the player can sail to', () => {
    LOOPS.forEach((L, i) => {
      for (let s = 0; s < L.total; s += 25) {
        const P = L.at(s);
        expect(P.x, `loop ${i} x`).toBeGreaterThan(WB.x0);
        expect(P.x, `loop ${i} x`).toBeLessThan(WB.x1);
        expect(P.z, `loop ${i} z`).toBeGreaterThan(WB.z0);
        expect(P.z, `loop ${i} z`).toBeLessThan(WB.z1);
      }
    });
  });

  it('are in different parts of the world, so he is not always off the same key', () => {
    for (let i = 0; i < LOOPS.length; i++) {
      for (let j = i + 1; j < LOOPS.length; j++) {
        const a = LOOPS[i].at(0), b = LOOPS[j].at(0);
        expect(Math.hypot(a.x - b.x, a.z - b.z), `loops ${i} and ${j}`).toBeGreaterThan(500);
      }
    }
  });
});

describe('whether Larry is out', () => {
  it('is the same answer for everyone at the same moment', () => {
    for (let k = 0; k < 150; k++) {
      const t = Date.UTC(2026, 2, 9) + k * 97_000;
      const a = larryAt(t, LOOPS.length);
      expect(a).toEqual(larryAt(t, LOOPS.length));
      expect(a.route).toBeGreaterThanOrEqual(0);
      expect(a.route).toBeLessThan(LOOPS.length);
    }
  });

  it('is sometimes yes and sometimes no, rather than effectively always one', () => {
    let out = 0;
    const N = 600;
    for (let k = 0; k < N; k++) out += larryAt(Date.UTC(2026, 2, 9) + k * 11 * 60 * 1000, LOOPS.length).out ? 1 : 0;
    // "Once in a while": common enough to be findable, rare enough to be a surprise.
    expect(out / N).toBeGreaterThan(0.25);
    expect(out / N).toBeLessThan(0.6);
  });

  it('uses every loop', () => {
    const seen = new Set<number>();
    for (let k = 0; k < 400; k++) seen.add(larryAt(Date.UTC(2026, 2, 9) + k * 11 * 60 * 1000, LOOPS.length).route);
    expect(seen.size).toBe(LOOPS.length);
  });
});
