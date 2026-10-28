/**
 * What goes on an estate's boat lift.
 *
 * The lift frame is derived from the boat's own length and beam, so the thing worth pinning is
 * the pairing: a boat only lands on a lift the dock could actually have floated it onto.
 */
import { describe, it, expect } from 'vitest';
import { liftBoatFor } from '../src/world/waterfront.js';
import { BOATS } from '@keysrun/shared/content/boats';

describe('picking the boat for a lift', () => {
  it('never puts a boat on a lift it could not have been driven onto', () => {
    for (let d = 1.15; d < 6; d += 0.05) {
      for (let r = 0; r < 1; r += 0.07) {
        const b = liftBoatFor(d, r);
        // Floated on under her own power, with room to spare for squat.
        expect(b.draft + 0.5, `${b.id} on a lift in ${d.toFixed(2)} m`).toBeLessThan(d);
      }
    }
  });

  it('falls back to the shallowest-draft boat rather than nothing', () => {
    // MIN_DOCK_DEPTH is 1.15 m and the shallowest boat needs 1.1 m, so there is a sliver of
    // depth where nothing qualifies. An empty lift is a worse answer than a small boat.
    const shallowest = BOATS.reduce((a, b) => (b.draft < a.draft ? b : a));
    for (const r of [0, 0.5, 0.99]) expect(liftBoatFor(0.3, r).id).toBe(shallowest.id);
  });

  it('puts bigger boats on deeper docks', () => {
    // Not a hard ordering — the hash picks within what fits — but the deepest docks must be able
    // to hold boats the shallow ones cannot, or the depth test is doing nothing.
    const atShallow = new Set<string>();
    const atDeep = new Set<string>();
    for (let r = 0; r < 1; r += 0.02) {
      atShallow.add(liftBoatFor(1.3, r).id);
      atDeep.add(liftBoatFor(5, r).id);
    }
    expect(atDeep.size).toBeGreaterThan(atShallow.size);
    for (const id of atShallow) expect(atDeep.has(id), `${id} fits shallow but not deep`).toBe(true);
  });

  it('is deterministic and uses the whole fleet across the world', () => {
    expect(liftBoatFor(3.2, 0.41).id).toBe(liftBoatFor(3.2, 0.41).id);
    const seen = new Set<string>();
    for (let d = 1.6; d < 5; d += 0.1) for (let r = 0; r < 1; r += 0.05) seen.add(liftBoatFor(d, r).id);
    // "Randomize them" means every hull in the game should turn up on somebody's lift.
    expect(seen.size).toBe(BOATS.length);
  });
});
