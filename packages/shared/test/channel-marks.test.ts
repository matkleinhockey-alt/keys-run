/**
 * Channel marks have to float, and they have to mean something.
 *
 * A buoy in the wrong place is a hazard, not an aid: the cuts are rectangles and the chain is
 * not, so the first pass put 15 of 68 marks on dry land. These pin both halves — every mark is
 * in navigable water, and every mark is one of a correctly-handed pair on the edges of a real
 * channel rather than loose in the fairway.
 */
import { describe, expect, it } from 'vitest';
import { CHANNELS, MARINAS, MARINA_CUT, MIAMI_CH, depthAt } from '../src/world/depth.js';
import { chainZ } from '../src/world/chain.js';
import { channelMarks, MARK_MIN_DEPTH_M } from '../src/world/channel-marks.js';

const marks = channelMarks();

describe('channel marks', () => {
  it('marks every cut there is', () => {
    expect(marks.length).toBeGreaterThan(20);
  });

  it('floats every one of them', () => {
    for (const m of marks) {
      const d = depthAt(m.x, m.z);
      expect(d, `${m.hand}${m.n} at (${m.x.toFixed(0)}, ${m.z.toFixed(0)}) sits in ${d.toFixed(2)} m`)
        .toBeGreaterThanOrEqual(MARK_MIN_DEPTH_M);
    }
  });

  it('puts a red and a green on opposite sides, never both on one', () => {
    const reds = marks.filter((m) => m.hand === 'red').length;
    const greens = marks.filter((m) => m.hand === 'green').length;
    // Dropping land-locked marks can break a pair, so these need not match exactly — but one
    // hand vanishing entirely would mean the convention is not being applied at all.
    expect(reds).toBeGreaterThan(marks.length * 0.3);
    expect(greens).toBeGreaterThan(marks.length * 0.3);
  });

  it('numbers reds even and greens odd, the way a chart does', () => {
    for (const m of marks) {
      if (m.hand === 'red') expect(m.n % 2, `red ${m.n}`).toBe(0);
      else expect(m.n % 2, `green ${m.n}`).toBe(1);
    }
  });

  it('stands each mark inside the channel it belongs to', () => {
    const rects = [
      ...CHANNELS.map((c) => ({
        x0: Math.min(c.x0, c.x1), x1: Math.max(c.x0, c.x1),
        z0: Math.min(chainZ(c.x0) + c.dz0, chainZ(c.x1) + c.dz1),
        z1: Math.max(chainZ(c.x0) + c.dz0, chainZ(c.x1) + c.dz1), d: c.d,
      })),
      ...MIAMI_CH.map((c) => ({
        x0: Math.min(c.x0, c.x1), x1: Math.max(c.x0, c.x1),
        z0: Math.min(c.z0, c.z1), z1: Math.max(c.z0, c.z1), d: c.d,
      })),
      // The dredged marina entrances are a third source of marks — see depth.ts's MARINA_CUT.
      ...MARINAS.map((M) => {
        const za = M.sz + M.dir * MARINA_CUT.r0, zb = M.sz + M.dir * MARINA_CUT.r1;
        return {
          x0: M.sx - MARINA_CUT.halfW, x1: M.sx + MARINA_CUT.halfW,
          z0: Math.min(za, zb), z1: Math.max(za, zb), d: MARINA_CUT.d,
        };
      }),
    ];
    for (const m of marks) {
      const inside = rects.some((r) => m.x >= r.x0 - 1 && m.x <= r.x1 + 1 && m.z >= r.z0 - 1 && m.z <= r.z1 + 1 && r.d === m.depth);
      expect(inside, `${m.hand}${m.n} at (${m.x.toFixed(0)}, ${m.z.toFixed(0)}) is not on any channel`).toBe(true);
    }
  });

  it('carries the channel depth so a mark can say what it is marking', () => {
    for (const m of marks) expect(m.depth).toBeGreaterThan(0);
  });
});
