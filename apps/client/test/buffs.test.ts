/**
 * The client side of food and drink: expiry really happens once per frame in simulated time, the
 * toasts fire on taking effect / wearing off, and the consumers (diver camera, strike window)
 * actually move. Node environment, no DOM: the runtime's HUD strip is optional by design.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buy, emptyInventory, type Inventory } from '@keysrun/shared/sim/shop';
import { createDiverState } from '@keysrun/shared/sim/diver';
import { handWobble, strikeWindowS, STRIKE_BASE_S } from '@keysrun/shared/sim/steady';
import { createBuffRuntime } from '../src/game/buffs.js';
import { createDiverCamState, updateDiverCamera } from '../src/entities/diver/camera.js';

function rig() {
  let inv: Inventory = emptyInventory();
  const toasts: string[] = [];
  const rt = createBuffRuntime({ getInventory: () => inv, setInventory: (i) => { inv = i; }, toast: (m) => toasts.push(m) });
  return { rt, toasts, get inv() { return inv; }, give: (v: Parameters<typeof buy>[1], id: string, now: number) => { inv = buy(inv, v, id, 1e6, now).inventory; } };
}

describe('buff runtime', () => {
  it('toasts on taking effect, prunes at expiry, toasts again, and reads nothing stale', () => {
    const r = rig();
    r.rt.update(0);
    r.give('diner', 'coffee', 0);
    expect(r.rt.update(1).steadyMul).toBeCloseTo(1.25);
    expect(r.toasts.length).toBe(1);
    expect(r.toasts[0]).toMatch(/Coffee/);
    // Step 1 simulated second at a time across the 600 s lifetime, the way frame() would.
    let t = 1;
    while (t < 599) r.rt.update(t++);
    expect(r.inv.buffs['diner.coffee']).toBeDefined();
    const after = r.rt.update(601);
    expect(after.steadyMul).toBe(1);
    expect(r.inv.buffs['diner.coffee']).toBeUndefined();
    expect(r.toasts[r.toasts.length - 1]).toMatch(/wears off/);
  });
  it('adopts buffs already present on the first frame silently (a loaded save)', () => {
    const r = rig();
    r.give('diner', 'coffee', 0);
    r.rt.update(10);
    expect(r.toasts).toEqual([]);
  });
  it('a second coffee says it topped up instead of stacking', () => {
    const r = rig();
    r.rt.update(0);
    r.give('diner', 'coffee', 0); r.rt.update(1);
    r.give('diner', 'coffee', 100); r.rt.update(101);
    expect(r.toasts[r.toasts.length - 1]).toMatch(/topped up/);
    expect(r.rt.mods.steadyMul).toBeCloseTo(1.25);
  });
});

describe('consumers move', () => {
  it('strike window: coffee longer, six-pack shorter', () => {
    const r = rig();
    r.rt.update(0);
    const base = strikeWindowS(STRIKE_BASE_S, r.rt.mods);
    r.give('diner', 'coffee', 0); r.rt.update(1);
    const coffee = strikeWindowS(STRIKE_BASE_S, r.rt.mods);
    r.give('liquor', 'sixer', 0); r.rt.update(2);
    const drunk = strikeWindowS(STRIKE_BASE_S, r.rt.mods);
    expect(coffee).toBeGreaterThan(base + 0.2);
    expect(drunk).toBeLessThan(coffee);
  });

  it('diver mask camera: a drink rolls the view, coffee quiets it, aim yaw/pitch untouched', () => {
    const state = createDiverState(0, -5, 0, 0);
    const roll = (hand: ReturnType<typeof handWobble> | undefined, t: number): THREE.Euler => {
      const cam = createDiverCamState(0);
      const camera = new THREE.PerspectiveCamera();
      updateDiverCamera(camera, cam, state, t, 0.05, hand);
      expect(cam.yaw).toBe(0); // the aim is cam.yaw/pitch; wobble must never write them
      return camera.rotation.clone();
    };
    const sober = { steadyMul: 1, sway: 0 };
    let maxDrunk = 0, maxSober = 0, maxCoffee = 0;
    for (let t = 0; t < 30; t += 0.25) {
      maxSober = Math.max(maxSober, Math.abs(roll(handWobble(t, sober), t).z));
      maxCoffee = Math.max(maxCoffee, Math.abs(roll(handWobble(t, { steadyMul: 1.25, sway: 0 }), t).z));
      maxDrunk = Math.max(maxDrunk, Math.abs(roll(handWobble(t, { steadyMul: 0.8, sway: 0.5 }), t).z));
    }
    expect(maxDrunk).toBeGreaterThan(maxSober * 3);
    expect(maxCoffee).toBeLessThan(maxSober);
    expect(maxDrunk).toBeLessThan(0.15); // visible, not a spin
  });
});
