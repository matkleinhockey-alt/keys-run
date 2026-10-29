/**
 * Getting off the boat anywhere there is a dock, and walking the land from there
 * (entities/land/ground.ts): the public fishing piers, the waterfront houses' private docks, the
 * keys themselves, and the step down off the town pad.
 */
import { describe, expect, it } from 'vitest';
import { PIERS, PIER_TOP } from '@keysrun/shared/world/piers';
import { PAD, TOWN_FRAME, toWorld } from '@keysrun/shared/world/town';
import { canStand, STEP_MAX } from '@keysrun/shared/sim/walker';
import { createLandController, WALK_ENV } from '../src/entities/land/controller.js';
import { naturalGround, type WalkDock } from '../src/entities/land/ground.js';

const canvas = { addEventListener() {}, removeEventListener() {}, setPointerCapture() {} } as unknown as HTMLCanvasElement;
const HULL = 9.3;

/** Walks a straight line in 0.4 m steps; true if every step is one the walker would take. */
function walkable(x0: number, z0: number, x1: number, z1: number): boolean {
  const n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.4);
  let y = WALK_ENV.ground(x0, z0);
  if (y === null) return false;
  for (let i = 1; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n, z = z0 + ((z1 - z0) * i) / n;
    if (!canStand(WALK_ENV, x, z, y)) return false;
    y = WALK_ENV.ground(x, z)!;
  }
  return true;
}

describe('fishing piers', () => {
  it('there are some, and each one is tied up at, stood on, and fished off', () => {
    expect(PIERS.length).toBeGreaterThanOrEqual(3);
    for (const p of PIERS) {
      const c = createLandController({ canvas });
      // a boat lying off the T's seaward face
      const boat = { x: p.x1 + p.nx * 7, z: p.z1 + p.nz * 7, h: 0, speed: 0 };
      expect(c.tryEnter(boat, HULL).ok, p.name).toBe(true);
      expect(c.mooring?.marina).toBe(p.name);
      expect(c.state!.y).toBeCloseTo(PIER_TOP, 5);
      expect(c.fishingDeck()).toBe(p.name);
    }
  });

  it('each one walks off its end onto the key', () => {
    for (const p of PIERS) {
      const inland = 10;
      expect(walkable(p.x1, p.z1, p.x0 - p.nx * inland, p.z0 - p.nz * inland), p.name).toBe(true);
    }
  });
});

describe('the land', () => {
  it('is walkable where it is dry and stops at the water', () => {
    const p = PIERS[0];
    expect(naturalGround(p.x0 - p.nx * 10, p.z0 - p.nz * 10)).not.toBeNull();
    expect(naturalGround(p.x1 + p.nx * 30, p.z1 + p.nz * 30)).toBeNull();
  });

  it('can be walked onto off the back of the town pad', () => {
    // u = -60: clear of the back fence that closes the middle of the pad's back edge
    const [x0, z0] = toWorld(TOWN_FRAME, -60, PAD.v1 - 6), [x1, z1] = toWorld(TOWN_FRAME, -60, PAD.v1 + 6);
    expect(walkable(x0, z0, x1, z1)).toBe(true);
    expect(STEP_MAX).toBeLessThan(0.75); // the pad edge itself is still a step too far; the apron is what makes it work
  });
});

describe('private docks', () => {
  it('are somewhere to tie up and to fish off', () => {
    const p = PIERS[0];
    // a dock running out from the same shore as the first pier, 40 m along it
    const ox = p.x0 - p.nz * 40, oz = p.z0 + p.nx * 40;
    const dock: WalkDock = { x0: ox, z0: oz, nx: p.nx, nz: p.nz, len: 40, w: 2.4, top: 1.16, name: 'a private dock' };
    const c = createLandController({ canvas, docks: [dock] });
    const boat = { x: ox + p.nx * 30 + p.nz * 4, z: oz + p.nz * 30 - p.nx * 4, h: 0, speed: 0 };
    expect(c.tryEnter(boat, HULL).ok).toBe(true);
    expect(c.mooring?.marina).toBe('a private dock');
    expect(c.fishingDeck()).toBe('a private dock');
  });
});
