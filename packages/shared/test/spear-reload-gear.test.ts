/**
 * The gun shop's band gun is a faster reload, not just a longer one.
 *
 * The reload is two phases: a braced recover (`SPEAR_RELOAD`, floored by `SPEAR_RELOAD_FLOOR`) and
 * a hand-hauled draw (`SPEAR_DRAW_TIME`). Gear scales ONLY the draw — the floor is an anti-cheat
 * bound the server checks, and no purchase may buy past it. These tests pin both halves of that.
 */
import { describe, expect, it } from 'vitest';
import {
  startReload, stepReload, canFire, SPEAR_RELOAD_FLOOR, SPEAR_DRAW_TIME,
} from '../src/sim/spear.js';
import { buy, emptyInventory, modifiersFor } from '../src/sim/shop.js';

const DT = 1 / 60;
/** A diver holding the draw with both hands and not kicking — the best case. */
const HAND = { drawing: true, speed: 0 };

/** Simulated seconds from the shot to the gun being ready again. */
function reloadSeconds(reloadMul: number): number {
  let gun = startReload();
  let t = 0;
  for (let i = 0; i < 60 * 60; i++) {
    gun = stepReload(gun, DT, HAND, reloadMul);
    t += DT;
    if (canFire(gun)) return t;
  }
  return Infinity;
}

const own = (...ids: string[]) => {
  let inv = emptyInventory();
  for (const id of ids) inv = buy(inv, 'guns', id, 1e6, 0).inventory;
  return modifiersFor(inv, 0);
};

describe('the band gun reloads faster', () => {
  it('stock is unchanged — no gear means exactly the old timing', () => {
    expect(modifiersFor(emptyInventory(), 0).spearReloadMul).toBe(1);
    const stock = reloadSeconds(1);
    // Recover floor plus the full hauled draw, give or take a tick.
    expect(stock).toBeGreaterThan(SPEAR_RELOAD_FLOOR);
    expect(stock).toBeLessThan(SPEAR_RELOAD_FLOOR + SPEAR_DRAW_TIME + 1.2);
  });

  it('the long gun is meaningfully quicker back into action', () => {
    const stock = reloadSeconds(1);
    const upgraded = reloadSeconds(own('spear-long').spearReloadMul);
    expect(upgraded).toBeLessThan(stock * 0.85);
  });

  it('the reel conversion stacks with it', () => {
    const long = reloadSeconds(own('spear-long').spearReloadMul);
    const both = reloadSeconds(own('spear-long', 'spear-reel').spearReloadMul);
    expect(both).toBeLessThan(long);
  });

  it('cannot buy past the anti-cheat floor, however good the gear gets', () => {
    // The thing that must never happen: gear turning the reload into a non-mechanic. Even an
    // absurd multiplier leaves the braced recover phase intact.
    expect(reloadSeconds(0.0001)).toBeGreaterThan(SPEAR_RELOAD_FLOOR);
  });
});
