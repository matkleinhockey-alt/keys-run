/**
 * Land mode's state machine and the town's gating, without a browser.
 *
 * What is NOT here: placement (every building, car, lamp and doorstep against `landH`/`depthAt`/
 * `shoreInfo`) lives in packages/shared/test/town.test.ts, next to the pure data it checks, and
 * the walker's physics in packages/shared/test/walker.test.ts. What this file proves is the part
 * only the client owns: that you cannot tie up where you should not, that every way out of land
 * mode works, and that the town costs nothing until you are near it.
 *
 * Mode transitions in the real renderer (camera, HUD, input bindings restored over repeated
 * boat -> land -> boat and boat -> diver -> boat) are asserted by test/capture-town.mjs `modes`,
 * which needs a GPU context and so cannot run under vitest.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MARINAS } from '@keysrun/shared/world/depth';
import { marinaDecks, groundAt, DECK_TOP } from '@keysrun/shared/world/town';
import { createLandController, TIE_UP_MAX_SPEED, BOARD_REACH } from '../src/entities/land/controller.js';
import { createLightPool, POOL } from '../src/entities/town/lights.js';
import { createTown, BUILD_RANGE, NEAR_RANGE, FAR_RANGE, LIGHT_HOT_RANGE } from '../src/entities/town/town.js';

const canvas = { addEventListener() {}, removeEventListener() {}, setPointerCapture() {} } as unknown as HTMLCanvasElement;
const HULL = 9.3;

/** A boat lying alongside the town marina's T-head, as `capture-town.mjs` and a player would put it. */
function alongsideTHead(): { x: number; z: number; h: number; speed: number } {
  const m = MARINAS[0];
  return { x: m.sx, z: m.sz + m.dir * 55, h: Math.PI, speed: 0 };
}

describe('tying up', () => {
  it('works for a boat alongside any of the four marinas', () => {
    for (const m of MARINAS) {
      const c = createLandController({ canvas });
      const [, T] = marinaDecks(m);
      const boat = { x: (T.x0 + T.x1) / 2, z: m.sz + m.dir * 55, h: 0, speed: 0 };
      expect(c.canTieUp(boat, HULL).ok, m.name).toBe(true);
      expect(c.tryEnter(boat, HULL).ok, m.name).toBe(true);
      expect(c.mode).toBe('land');
      // and you start standing on the planks, not in the water
      expect(groundAt(c.state!.x, c.state!.z), m.name).not.toBeNull();
    }
  });

  it('refuses a boat that is still moving, with a reason', () => {
    const c = createLandController({ canvas });
    const r = c.tryEnter({ ...alongsideTHead(), speed: TIE_UP_MAX_SPEED + 1 }, HULL);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/slow down/i);
    expect(c.mode).toBe('boat');
  });

  it('refuses a boat in open water and one on the wrong side of the harbour', () => {
    const c = createLandController({ canvas });
    const m = MARINAS[0];
    expect(c.tryEnter({ x: m.sx + 300, z: m.sz + 300, h: 0, speed: 0 }, HULL).ok).toBe(false);
    expect(c.tryEnter({ x: m.sx, z: m.sz + 90, h: 0, speed: 0 }, HULL).ok).toBe(false);
    expect(c.mode).toBe('boat');
    expect(c.state).toBeNull();
  });

  it('cannot be entered twice', () => {
    const c = createLandController({ canvas });
    expect(c.tryEnter(alongsideTHead(), HULL).ok).toBe(true);
    expect(c.tryEnter(alongsideTHead(), HULL).ok).toBe(false);
  });

  it('records the mooring where the boat actually is, for holdBoat to pin', () => {
    const c = createLandController({ canvas });
    const boat = alongsideTHead();
    c.tryEnter(boat, HULL);
    expect(c.mooring).toMatchObject({ boatX: boat.x, boatZ: boat.z, boatH: boat.h });
    expect(c.mooring!.marina).toBe(MARINAS[0].name);
  });
});

describe('getting back', () => {
  it('boards when you are at the boat, and clears everything it set up', () => {
    const c = createLandController({ canvas });
    c.tryEnter(alongsideTHead(), HULL);
    expect(c.boardDistance()).toBeLessThanOrEqual(BOARD_REACH);
    expect(c.board()).toBe('boarded');
    expect(c.mode).toBe('boat');
    expect(c.state).toBeNull();
    expect(c.mooring).toBeNull();
    expect(c.board()).toBe('idle');
  });

  it('says you are too far, and a second press takes a cab back to the dock', () => {
    const c = createLandController({ canvas });
    c.tryEnter(alongsideTHead(), HULL);
    const m = MARINAS[0];
    // walk (teleport) to the far back corner of town
    expect(c.debugPlace(m.sx + 95, m.sz - 128, 0)).toBe(true);
    expect(c.boardDistance()).toBeGreaterThan(BOARD_REACH);
    expect(c.board()).toBe('far');
    expect(c.mode).toBe('land');
    expect(c.board()).toBe('cab');
    expect(c.boardDistance()).toBeLessThanOrEqual(BOARD_REACH);
    expect(groundAt(c.state!.x, c.state!.z)).toBe(DECK_TOP);
    expect(c.board()).toBe('boarded');
  });

  it('forgets a lone far press, so a stray B much later does not cab you', () => {
    const c = createLandController({ canvas });
    c.tryEnter(alongsideTHead(), HULL);
    const m = MARINAS[0];
    c.debugPlace(m.sx + 95, m.sz - 128, 0);
    expect(c.board()).toBe('far');
    for (let i = 0; i < 30 * 5; i++) c.step(1 / 30, false); // five seconds
    expect(c.board()).toBe('far');
  });

  it('exitToBoat always works, from anywhere, and is idempotent', () => {
    const c = createLandController({ canvas });
    const m = MARINAS[0];
    c.tryEnter(alongsideTHead(), HULL);
    c.debugPlace(m.sx - 95, m.sz - 120, 1);
    c.exitToBoat();
    expect(c.mode).toBe('boat');
    c.exitToBoat();
    expect(c.mode).toBe('boat');
    // and it can go ashore again afterwards: no state survived
    expect(c.tryEnter(alongsideTHead(), HULL).ok).toBe(true);
    expect(c.mooring!.boatX).toBe(alongsideTHead().x);
  });

  it('refuses to place the walker in the sea or inside a wall', () => {
    const c = createLandController({ canvas });
    const m = MARINAS[0];
    c.tryEnter(alongsideTHead(), HULL);
    expect(c.debugPlace(m.sx, m.sz + 80, 0)).toBe(false);          // open harbour
    expect(c.debugPlace(m.sx + 21, m.sz - 61.4, 0)).toBe(false);   // on top of the bar counter
    // The club is walk-in now (you own it), so its floor is legitimately standable — what must
    // still refuse is the furniture. Replacing rather than deleting this case: "inside the club"
    // stopped being a blocked point the moment the rope came down, and a test that only checked
    // the old solid footprint would have quietly stopped testing anything.
    expect(c.debugPlace(m.sx + 50, m.sz - 67, 0)).toBe(false);     // on top of the club stage
    expect(c.debugPlace(m.sx + 64, m.sz - 61, 0)).toBe(false);     // inside the owner's booth
    expect(c.debugPlace(m.sx + 50, m.sz - 56, 0)).toBe(true);      // the dance floor, now open to you
  });
});

describe('a frozen walker (a venue panel is open) stands still', () => {
  it('ignores held keys while frozen and moves again when it is not', () => {
    const c = createLandController({ canvas });
    c.tryEnter(alongsideTHead(), HULL);
    const x0 = c.state!.x, z0 = c.state!.z;
    c.buttons.fwd = true;
    for (let i = 0; i < 60; i++) c.step(1 / 30, true);
    expect(Math.hypot(c.state!.x - x0, c.state!.z - z0)).toBeLessThan(0.01);
    for (let i = 0; i < 60; i++) c.step(1 / 30, false);
    expect(Math.hypot(c.state!.x - x0, c.state!.z - z0)).toBeGreaterThan(1);
  });
});

describe('the town costs nothing until you are near it', () => {
  function make() {
    const scene = new THREE.Scene();
    const town = createTown({ scene, lightMats: [], getTodK: () => 0, onBuilt: () => {} });
    return { scene, town };
  }

  it('keeps its tiers nested: build, then far, then near', () => {
    expect(NEAR_RANGE).toBeLessThan(FAR_RANGE);
    expect(BUILD_RANGE).toBeLessThan(FAR_RANGE);
    expect(LIGHT_HOT_RANGE).toBeLessThan(NEAR_RANGE);
  });

  it('is not built, not in the scene and not visible while the camera is out at sea', () => {
    const { scene, town } = make();
    const m = MARINAS[0];
    for (const d of [BUILD_RANGE + 50, 2500, 6000]) {
      for (let i = 0; i < 20; i++) town.update(1 / 30, i / 30, new THREE.Vector3(m.sx, 5, m.sz + 55 + d));
    }
    const s = town.stats();
    expect(s.built).toBe(false);
    expect(s.building).toBe(false);
    expect(s.stagesDone).toBe(0);
    expect(s.lightsActive).toBe(false);
    expect(scene.children).toHaveLength(0);
    expect(town.root.visible).toBe(false);
  });

  it('answers interaction queries without having been built (cheap, pure data)', () => {
    const { town } = make();
    expect(town.nearestInteract(0, 0)).toBeNull();
    expect(town.insideLot(0, 0)).toBeNull();
  });
});

describe('the light pool', () => {
  const cam = new THREE.Vector3(0, 0, 0);
  const src = [{ x: 3, y: 4, z: 0, color: 0xffe2a8, kind: 'lamp' as const }, { x: 9, y: 3, z: 2, color: 0xff3fa4, kind: 'neon' as const, lot: 'club' }];
  const lights = (g: THREE.Group): THREE.PointLight[] => g.children.filter((c): c is THREE.PointLight => (c as THREE.PointLight).isPointLight);

  it('always owns exactly POOL lights, and they are all on or all off', () => {
    const g = new THREE.Group();
    const pool = createLightPool(g);
    expect(lights(g)).toHaveLength(POOL);
    const states = new Set<string>();
    for (const [night, hot, inside] of [[0, true, null], [0.3, true, null], [1, true, null], [1, false, null], [0, true, 'bar'], [0, false, null]] as const) {
      pool.update(cam, src, night, hot, inside);
      const vis = lights(g).map((l) => l.visible);
      expect(new Set(vis).size, `night=${night} hot=${hot}`).toBe(1);
      states.add(String(vis[0]));
    }
    expect(states.size).toBe(2);
  });

  it('is off by day in the street, on at sunset, and on indoors even by day', () => {
    const g = new THREE.Group();
    const pool = createLightPool(g);
    pool.update(cam, src, 0, true, null);
    expect(pool.active).toBe(false);
    pool.update(cam, src, 0.6, true, null);
    expect(pool.active).toBe(true);
    pool.update(cam, src, 0, true, 'bar');
    expect(pool.active).toBe(true);
  });

  it('does not flap on the edge of dusk: it switches on high and off low', () => {
    const g = new THREE.Group();
    const pool = createLightPool(g);
    const seq: boolean[] = [];
    for (const k of [0.2, 0.26, 0.2, 0.18, 0.2, 0.15, 0.1, 0.2]) { pool.update(cam, src, k, true, null); seq.push(pool.active); }
    // on at 0.26, stays on through 0.2/0.18/0.15, off at 0.1, and stays off at 0.2 (below the on threshold)
    expect(seq).toEqual([false, true, true, true, true, true, false, false]);
  });

  it('turns off when the camera leaves the town, whatever the hour', () => {
    const g = new THREE.Group();
    const pool = createLightPool(g);
    pool.update(cam, src, 1, true, null);
    expect(pool.active).toBe(true);
    pool.update(cam, src, 1, false, null);
    expect(pool.active).toBe(false);
    expect(lights(g).every((l) => !l.visible)).toBe(true);
  });
});
