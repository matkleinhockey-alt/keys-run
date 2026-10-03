import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/rng/index.js';
import {
  SPEAR_SPEED, SPEAR_RANGE, SPEAR_RELOAD, SPEAR_RELOAD_FLOOR,
  createGun, canFire, stepReload, startReload,
  fire, stepSpear, closestDistSqSegmentSegment, segmentHitsCapsule,
  spearFightParamsFor, startSpearFight, stepSpearFight,
  type CapsuleTarget, type ShotState, type SpearFightState,
} from '../src/sim/spear.js';

const DT = 1 / 30;

function runShot(shot: ShotState, targets: readonly CapsuleTarget[], maxSteps = 200) {
  let s = shot;
  let hit = null;
  let steps = 0;
  while (s.alive && !hit && steps < maxSteps) {
    const r = stepSpear(s, targets, DT);
    s = r.shot;
    hit = r.hit;
    steps++;
  }
  return { shot: s, hit, steps };
}

describe('closestDistSqSegmentSegment', () => {
  it('is zero for intersecting segments', () => {
    const { distSq } = closestDistSqSegmentSegment(
      { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
      { x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 },
    );
    expect(distSq).toBeCloseTo(0, 9);
  });

  it('matches the known perpendicular distance for parallel offset segments', () => {
    const { distSq } = closestDistSqSegmentSegment(
      { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 },
      { x: 0, y: 3, z: 0 }, { x: 10, y: 3, z: 0 },
    );
    expect(distSq).toBeCloseTo(9, 9);
  });

  it('is symmetric in its arguments', () => {
    const a = closestDistSqSegmentSegment(
      { x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 },
      { x: 2, y: 4, z: 1 }, { x: 2, y: -4, z: 1 },
    );
    const b = closestDistSqSegmentSegment(
      { x: 2, y: 4, z: 1 }, { x: 2, y: -4, z: 1 },
      { x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 },
    );
    expect(a.distSq).toBeCloseTo(b.distSq, 9);
  });
});

describe('segmentHitsCapsule / stepSpear (ray/capsule hit tests)', () => {
  const straightAhead: CapsuleTarget = {
    id: 'fish-1', ax: 0, ay: 0, az: 5, bx: 0, by: 0, bz: 5.6, radius: 0.3,
  };

  it('segmentHitsCapsule reports hit=true for a ray that pierces the capsule radius', () => {
    const { hit, s } = segmentHitsCapsule({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }, straightAhead);
    expect(hit).toBe(true);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });

  it('segmentHitsCapsule reports hit=false for a ray that passes outside the radius', () => {
    const offToTheSide: CapsuleTarget = { id: 'fish-2', ax: 3, ay: 0, az: 5, bx: 3, by: 0, bz: 5.6, radius: 0.3 };
    const { hit } = segmentHitsCapsule({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }, offToTheSide);
    expect(hit).toBe(false);
  });

  it('hits a capsule directly in the shaft path, within range', () => {
    const shot = fire({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const { hit, steps } = runShot(shot, [straightAhead]);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe('fish-1');
    expect(hit!.atDist).toBeGreaterThan(4.5);
    expect(hit!.atDist).toBeLessThan(6);
    expect(steps).toBeGreaterThan(0);
  });

  it('misses a capsule well off to the side', () => {
    const offToTheSide: CapsuleTarget = { id: 'fish-2', ax: 3, ay: 0, az: 5, bx: 3, by: 0, bz: 5.6, radius: 0.3 };
    const shot = fire({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const { hit } = runShot(shot, [offToTheSide]);
    expect(hit).toBeNull();
  });

  it('picks the nearer of two targets in line', () => {
    const near: CapsuleTarget = { id: 'near', ax: 0, ay: 0, az: 3, bx: 0, by: 0, bz: 3.4, radius: 0.3 };
    const far: CapsuleTarget = { id: 'far', ax: 0, ay: 0, az: 6, bx: 0, by: 0, bz: 6.4, radius: 0.3 };
    const shot = fire({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const { hit } = runShot(shot, [far, near]);
    expect(hit?.id).toBe('near');
  });

  it('enforces the range limit: a target beyond SPEAR_RANGE is never hit', () => {
    const beyond: CapsuleTarget = { id: 'too-far', ax: 0, ay: 0, az: 20, bx: 0, by: 0, bz: 20.6, radius: 0.5 };
    const shot = fire({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const { shot: finalShot, hit, steps } = runShot(shot, [beyond], 100);
    expect(hit).toBeNull();
    expect(finalShot.alive).toBe(false);
    expect(finalShot.dist).toBeLessThanOrEqual(SPEAR_RANGE + 1e-6);
    expect(finalShot.dist).toBeGreaterThan(SPEAR_RANGE - SPEAR_SPEED * DT - 1e-6);
    expect(steps).toBeGreaterThan(0);
  });

  it('a stationary shaft with no hit this step reports alive while short of range', () => {
    const shot = fire({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    const { shot: next, hit } = stepSpear(shot, [], DT);
    expect(hit).toBeNull();
    expect(next.alive).toBe(true);
    expect(next.dist).toBeCloseTo(SPEAR_SPEED * DT, 9);
  });

  it('normalizes a non-unit direction', () => {
    const shot = fire({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 });
    expect(shot.dz).toBeCloseTo(1, 9);
    expect(shot.dx).toBeCloseTo(0, 9);
  });
});

describe('reload gating', () => {
  it('a fresh gun can fire', () => {
    expect(canFire(createGun())).toBe(true);
  });

  it('cannot fire immediately after a shot, and can again once reloaded', () => {
    let gun = startReload(SPEAR_RELOAD);
    expect(canFire(gun)).toBe(false);
    const steps = Math.ceil(SPEAR_RELOAD / DT);
    for (let i = 0; i < steps - 1; i++) {
      gun = stepReload(gun, DT);
      expect(canFire(gun)).toBe(false);
    }
    gun = stepReload(gun, DT);
    expect(canFire(gun)).toBe(true);
  });

  it('never allows a reload shorter than the anti-cheat floor', () => {
    const gun = startReload(0.1); // a hostile/buggy caller asking for a near-instant reload
    expect(gun.reloadT).toBeGreaterThanOrEqual(SPEAR_RELOAD_FLOOR);
  });

  it('stepReload is a no-op once loaded', () => {
    const loaded = createGun();
    expect(stepReload(loaded, DT)).toBe(loaded);
  });
});

describe('speared-fish fight', () => {
  function run(
    state: SpearFightState, params: ReturnType<typeof spearFightParamsFor>, env: { diverX: number; diverZ: number },
    rng: ReturnType<typeof mulberry32>, hauling: boolean, maxSteps: number,
  ) {
    let s = state, steps = 0;
    while (s.outcome === 'fighting' && steps < maxSteps) {
      s = stepSpearFight(s, { hauling }, params, env, rng, DT);
      steps++;
    }
    return { state: s, steps };
  }

  it('is winnable: a weak fish hauled in gently gets landed', () => {
    const rng = mulberry32(21);
    const params = spearFightParamsFor('trout', 4);
    const state = startSpearFight(5, 0);
    const env = { diverX: 0, diverZ: 0 };
    // Bang-bang: haul while safe, ease off near the danger zone.
    let s = state, steps = 0;
    while (s.outcome === 'fighting' && steps < 20000) {
      s = stepSpearFight(s, { hauling: s.tension < 0.85 }, params, env, rng, DT);
      steps++;
    }
    expect(s.outcome).toBe('landed');
  });

  it('is losable: hauling flat out tears the shaft free on a strong fish', () => {
    const rng = mulberry32(22);
    const params = spearFightParamsFor('marlin', 400); // high str: tension wins the race, see spear.ts
    const state = startSpearFight(5, 0);
    const env = { diverX: 0, diverZ: 0 };
    const { state: final } = run(state, params, env, rng, true, 2000);
    expect(final.outcome).toBe('tornFree');
  });

  it('never produces NaN or negative stamina', () => {
    const rng = mulberry32(23);
    const params = spearFightParamsFor('amberjack', 40);
    let s = startSpearFight(4, 2);
    const env = { diverX: 0, diverZ: 0 };
    for (let i = 0; i < 300 && s.outcome === 'fighting'; i++) {
      s = stepSpearFight(s, { hauling: i % 2 === 0 }, params, env, rng, DT);
      expect(s.stam).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(s.x)).toBe(true);
      expect(Number.isFinite(s.z)).toBe(true);
      expect(Math.hypot(s.x - env.diverX, s.z - env.diverZ)).toBeLessThanOrEqual(params.tetherMax + 1e-6);
    }
  });
});
