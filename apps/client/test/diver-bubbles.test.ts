/**
 * The diver's bubbles, and the one law that makes them read as underwater.
 *
 * A bubble holds its gas, so as it rises into lower pressure it expands — volume with the
 * pressure ratio, radius with the cube root of it. That is the behaviour worth pinning: the
 * emission rates are taste, but a bubble that does not grow on the way up is just a white dot.
 */
import { describe, expect, it } from 'vitest';
import { createDiverBubbles } from '../src/entities/diver/bubbles.js';
import { createDiverState, type DiverState } from '@keysrun/shared/sim/diver';

const DT = 1 / 30;

function diverAt(depth: number, air = 1): DiverState {
  const s = createDiverState(0, -depth, 0, 0);
  s.air = s.airMax * air;
  return s;
}

/**
 * Step with no diver so nothing new spawns, following ONE bubble all the way up.
 *
 * Locking onto a single slot matters: sampling "whichever bubble is alive first" hops between
 * bubbles at different depths and produces a depth series that jumps around, which is how the
 * first version of this test managed to be looking at a bubble 8 m from where it thought it was.
 */
function riseAndSample(b: ReturnType<typeof createDiverBubbles>, geo: { y: number[]; r: number[] }, steps: number): void {
  const pos = b.points.geometry.getAttribute('position');
  const siz = b.points.geometry.getAttribute('psize');
  const al = b.points.geometry.getAttribute('alpha');
  let slot = -1;
  for (let i = 0; i < pos.count; i++) if (al.getX(i) > 0) { slot = i; break; }
  if (slot < 0) return;
  for (let n = 0; n < steps; n++) {
    b.update(DT, null, [], n * DT);
    if (al.getX(slot) <= 0) break;   // it surfaced; the series ends there
    geo.y.push(pos.getY(slot));
    geo.r.push(siz.getX(slot));
  }
}

describe('diver bubbles', () => {
  it('leaks nothing at the surface and streams once you are down', () => {
    const b = createDiverBubbles(1);
    b.update(DT, diverAt(0.1), [], 0);
    expect(b.debug().rate).toBe(0);

    for (let n = 0; n < 60; n++) b.update(DT, diverAt(12), [], n * DT);
    expect(b.debug().rate).toBeGreaterThan(0);
    expect(b.debug().live, 'a dive should be producing bubbles').toBeGreaterThan(0);
    b.dispose();
  });

  it('leaks harder as the breath-hold runs out, and when working hard', () => {
    const b = createDiverBubbles(1);
    b.update(DT, diverAt(12, 1), [], 0);
    const easy = b.debug().rate;

    b.update(DT, diverAt(12, 0.08), [], DT);
    const desperate = b.debug().rate;
    expect(desperate, 'low air should leak more').toBeGreaterThan(easy * 2);

    const working = diverAt(12, 1);
    working.exertion = 1;
    b.update(DT, working, [], DT * 2);
    expect(b.debug().rate).toBeGreaterThan(easy);
    b.dispose();
  });

  it('grows a rising bubble by the cube root of the pressure ratio', () => {
    const b = createDiverBubbles(1);
    // One burst at 20 m (3 ATA) and nothing after it, so what we watch is a single population
    // rising freely.
    b.update(DT, diverAt(20), [{ type: 'surfaced' }], 0);

    const s: { y: number[]; r: number[] } = { y: [], r: [] };
    riseAndSample(b, s, 2600);
    expect(s.y.length, 'bubbles should have been tracked').toBeGreaterThan(50);

    // Compare the sample nearest 18 m down with the one nearest 6 m down. Radius ratio should be
    // cbrt(p(18)/p(6)) = cbrt(2.8/1.6) = 1.207.
    const near = (d: number): number => {
      let best = 0, bd = Infinity;
      for (let i = 0; i < s.y.length; i++) {
        const dd = Math.abs(-s.y[i] - d);
        if (dd < bd) { bd = dd; best = i; }
      }
      return best;
    };
    const deep = near(18), shallow = near(6);
    expect(Math.abs(-s.y[deep] - 18)).toBeLessThan(1.5);
    expect(Math.abs(-s.y[shallow] - 6)).toBeLessThan(1.5);

    const expected = Math.cbrt(ataAt(-s.y[deep]) / ataAt(-s.y[shallow]));
    const actual = s.r[shallow] / s.r[deep];
    expect(actual).toBeGreaterThan(1);               // it grew
    expect(actual).toBeCloseTo(expected, 2);         // ...by exactly the right amount
    b.dispose();
  });

  it('pops every bubble at the surface rather than letting them fly', () => {
    const b = createDiverBubbles(1);
    b.update(DT, diverAt(4), [{ type: 'surfaced' }], 0);
    expect(b.debug().live).toBeGreaterThan(0);
    for (let n = 0; n < 4000; n++) b.update(DT, null, [], n * DT);
    expect(b.debug().live, 'everything should have surfaced and gone').toBe(0);
    const pos = b.points.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) expect(pos.getY(i)).toBeLessThan(0.01);
    b.dispose();
  });

  it('lets the whole breath go on a blackout', () => {
    const b = createDiverBubbles(1);
    b.update(DT, diverAt(18), [], 0);
    const before = b.debug().live;
    b.update(DT, diverAt(18), [{ type: 'blackout', cause: 'airOut' }], DT);
    expect(b.debug().live - before).toBeGreaterThan(30);
    b.dispose();
  });
});

const ataAt = (depth: number): number => 1 + Math.max(0, depth) / 10;
