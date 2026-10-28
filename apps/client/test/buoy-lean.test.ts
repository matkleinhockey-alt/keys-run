/**
 * How far a channel buoy heels on the water it is actually floating on.
 *
 * The lean is a deliberate exaggeration of the surface gradient, and the size of that
 * exaggeration depends entirely on how steep the sea is. When short wind chop was added
 * (@keysrun/shared/waves' CHOP) the gradient a buoy sees went up four- to eight-fold and the old
 * gain pinned every buoy against its stop. This pins the property that broke: a buoy has to
 * MOVE with the sea state, which it cannot do once it is clamped.
 */
import { describe, expect, it } from 'vitest';
import { LEAN_GAIN, MAX_LEAN, SLOPE_SPAN } from '../src/world/channel-buoys.js';
import { waveHBase, SEA_STATES } from '@keysrun/shared/waves';
import { ampAt, chopAt } from '@keysrun/shared/sim/depth-grid';
import { chainZ } from '@keysrun/shared/world/chain';

/** Peak heel, in degrees, at a spot in a given sea — the same finite difference the buoy takes. */
function peakLeanDeg(x: number, z: number, sw: number, ch: number): number {
  const amp = ampAt(x, z), cp = chopAt(x, z);
  let g = 0;
  for (let t = 0; t < 120; t += 0.05) {
    const gx = (waveHBase(x + SLOPE_SPAN, z, t, amp, sw, ch, cp) - waveHBase(x - SLOPE_SPAN, z, t, amp, sw, ch, cp)) / (2 * SLOPE_SPAN);
    const gz = (waveHBase(x, z + SLOPE_SPAN, t, amp, sw, ch, cp) - waveHBase(x, z - SLOPE_SPAN, t, amp, sw, ch, cp)) / (2 * SLOPE_SPAN);
    g = Math.max(g, Math.hypot(gx, gz));
  }
  return Math.atan(Math.min(MAX_LEAN, g * LEAN_GAIN)) * 180 / Math.PI;
}

const SPOTS = [
  ['inshore channel', -900, chainZ(-900) + 140],
  ['offshore', 0, chainZ(0) + 900],
  ['deep', 0, chainZ(0) + 2600],
] as const;
const MAX_DEG = Math.atan(MAX_LEAN) * 180 / Math.PI;

describe('buoy lean', () => {
  it('never sits pinned against its stop in ordinary weather', () => {
    // The regression: at the old gain this was true in seven of nine combinations, so the buoys
    // all lay at the same angle no matter where you were or what the sea was doing.
    for (const [name, x, z] of SPOTS) {
      for (const S of SEA_STATES) {
        const d = peakLeanDeg(x, z, S.sw, S.ch);
        expect(d, `${name} / ${S.n} is clamped`).toBeLessThan(MAX_DEG - 1);
      }
    }
  });

  it('still leaves headroom for a wake to knock it further', () => {
    // A sportfisher running past is the moment the buoy should lurch. If the swell alone has
    // used the whole range there is nothing left to show.
    for (const [name, x, z] of SPOTS) {
      const worst = Math.max(...SEA_STATES.map((S) => peakLeanDeg(x, z, S.sw, S.ch)));
      expect(worst, `${name} leaves no room for a wake`).toBeLessThan(MAX_DEG * 0.88);
    }
  });

  it('reads as floating rather than as a post', () => {
    // The failure the exaggeration was introduced to fix: a faithful lean measured 0.02-0.38
    // degrees and looked like a piling.
    for (const [name, x, z] of SPOTS) {
      const choppy = SEA_STATES.find((S) => S.n === 'Choppy')!;
      expect(peakLeanDeg(x, z, choppy.sw, choppy.ch), `${name} barely moves`).toBeGreaterThan(3);
    }
  });

  it('heels further in a worse sea, everywhere', () => {
    // If the sea state does not change the buoy, the buoy is not reading the water.
    for (const [name, x, z] of SPOTS) {
      const calm = SEA_STATES.find((S) => S.n === 'Calm')!;
      const haul = SEA_STATES.find((S) => S.n === 'Haulover')!;
      expect(peakLeanDeg(x, z, haul.sw, haul.ch), name).toBeGreaterThan(peakLeanDeg(x, z, calm.sw, calm.ch) + 2);
    }
  });
});
