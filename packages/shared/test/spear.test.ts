import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/rng/index.js';
import {
  SPEAR_SPEED, SPEAR_RANGE, SPEAR_RELOAD, SPEAR_RELOAD_FLOOR,
  createGun, canFire, stepReload, startReload,
  fire, stepSpear, closestDistSqSegmentSegment, segmentHitsCapsule,
  distAtFlightTime, shaftSpeedAtDist, holdChance,
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
    // Under water drag the shaft no longer covers exactly SPEAR_SPEED*DT in one step — it covers
    // whatever the closed-form distAtFlightTime(DT) says (see SPEAR_DRAG_K's doc comment) — but it
    // must still be *close* to the undecayed value after one 1/30 s step (drag is a mild effect).
    expect(next.dist).toBeCloseTo(distAtFlightTime(DT), 9);
    expect(next.dist).toBeLessThan(SPEAR_SPEED * DT);
    expect(next.dist).toBeGreaterThan(SPEAR_SPEED * DT * 0.9);
    expect(next.t).toBeCloseTo(DT, 9);
  });

  it('normalizes a non-unit direction', () => {
    const shot = fire({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 5 });
    expect(shot.dz).toBeCloseTo(1, 9);
    expect(shot.dx).toBeCloseTo(0, 9);
  });
});

describe('trajectory (zero divergence across step size)', () => {
  // Despite water drag, `dist` is always derived from cumulative flight time via the closed-form
  // distAtFlightTime (see SPEAR_DRAG_K's doc comment) rather than accumulated step-by-step, so
  // summing many small steps must still land on exactly the same position as one big step
  // (mirroring the server's later need to rewind and re-integrate a shot from an arbitrary
  // rewound origin at whatever tick rate it runs, per docs/ARCHITECTURE.md's spearfishing
  // section, and get the identical answer the client predicted).
  it('many small steps sum to the same distance/position as one big step, short of the range clamp', () => {
    const totalT = 0.3; // comfortably under the (now longer, under drag) time to reach SPEAR_RANGE — no clamping involved
    const origin = { x: 1, y: -5, z: 2 };
    const dir = { x: 0.6, y: 0.1, z: -0.8 };

    const coarse = stepSpear(fire(origin, dir), [], totalT).shot;

    let fine = fire(origin, dir);
    const steps = 500;
    for (let i = 0; i < steps; i++) fine = stepSpear(fine, [], totalT / steps).shot;

    expect(fine.dist).toBeCloseTo(coarse.dist, 9);
    expect(fine.alive).toBe(coarse.alive);
  });

  it('a target is hit at (within floating point) the same point in space regardless of step size', () => {
    const origin = { x: 0, y: 0, z: 0 };
    const dir = { x: 0, y: 0, z: 1 };
    // Deliberately *not* collinear with the shaft's path (x offset by the capsule's own radius):
    // a ray running exactly along a capsule's spine is a measure-zero, physically-ambiguous
    // configuration (which endpoint is "the" entry point depends on which end you approach
    // from) — this is the realistic case, a diver aiming at a fish's body, not down its spine.
    const target: CapsuleTarget = { id: 'fish', ax: 0.2, ay: 0, az: 4.8, bx: 0.2, by: 0, bz: 5.6, radius: 0.3 };

    // `runShot` (this file's helper, above) always steps at the module `DT` (1/30, the server's
    // fixed tick per docs/ARCHITECTURE.md's netcode table) — step manually at DT/10 for the fine
    // comparison run.
    const coarse = runShot(fire(origin, dir), [target]);
    let fine = fire(origin, dir);
    let fineHit: ReturnType<typeof stepSpear>['hit'] = null;
    for (let i = 0; i < 2000 && fine.alive && !fineHit; i++) {
      const r = stepSpear(fine, [target], DT / 10);
      fine = r.shot;
      fineHit = r.hit;
    }

    expect(coarse.hit).not.toBeNull();
    expect(fineHit).not.toBeNull();
    // Both must find the same analytic impact point along the ray, independent of how finely the
    // flight was sliced into steps — the one coarse step that registers the hit can only overshoot
    // the true (fine-grained) crossing by at most that step's own travel distance.
    expect(Math.abs(coarse.hit!.point.z - fineHit!.point.z)).toBeLessThan(SPEAR_SPEED * DT);
  });
});

describe('water drag (range and power falloff)', () => {
  it('shaft speed decays linearly with distance and never exceeds muzzle speed', () => {
    expect(shaftSpeedAtDist(0)).toBeCloseTo(SPEAR_SPEED, 9);
    expect(shaftSpeedAtDist(SPEAR_RANGE)).toBeLessThan(SPEAR_SPEED);
    expect(shaftSpeedAtDist(SPEAR_RANGE)).toBeGreaterThan(SPEAR_SPEED * 0.5); // mild drag, not a stall
    // linear in distance: halfway to SPEAR_RANGE loses half as much speed as the full distance.
    const lossAtRange = SPEAR_SPEED - shaftSpeedAtDist(SPEAR_RANGE);
    const lossAtHalf = SPEAR_SPEED - shaftSpeedAtDist(SPEAR_RANGE / 2);
    expect(lossAtHalf).toBeCloseTo(lossAtRange / 2, 9);
  });

  it('distAtFlightTime is monotonically increasing and matches v0 at t=0', () => {
    expect(distAtFlightTime(0)).toBe(0);
    let prev = 0;
    for (let t = DT; t < 2; t += DT) {
      const d = distAtFlightTime(t);
      expect(d).toBeGreaterThan(prev);
      prev = d;
    }
  });

  it('a shot that travels the full SPEAR_RANGE arrives measurably slower than it left', () => {
    const shot = fire({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    const { shot: final } = runShot(shot, []);
    expect(final.dist).toBeCloseTo(SPEAR_RANGE, 6);
    expect(shaftSpeedAtDist(final.dist)).toBeLessThan(SPEAR_SPEED);
  });

  it('holdChance rises from ~0 near the edge of a drag-slowed range to a near-certain cap at muzzle speed', () => {
    expect(holdChance(0)).toBe(0);
    expect(holdChance(SPEAR_SPEED * 0.2)).toBe(0); // well below the no-hold floor
    expect(holdChance(SPEAR_SPEED)).toBeCloseTo(0.95, 9); // capped, never a guaranteed hold
    // monotonically non-decreasing in impact speed
    let prev = 0;
    for (let frac = 0; frac <= 1; frac += 0.05) {
      const c = holdChance(SPEAR_SPEED * frac);
      expect(c).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = c;
    }
    // a hit right at SPEAR_RANGE (slowed by drag) holds less reliably than a point-blank hit.
    expect(holdChance(shaftSpeedAtDist(SPEAR_RANGE))).toBeLessThan(holdChance(SPEAR_SPEED));
  });

  it('stepSpear without an rng always reports held=true (back-compat for existing callers)', () => {
    const target: CapsuleTarget = { id: 'fish', ax: 0, ay: 0, az: SPEAR_RANGE - 0.3, bx: 0, by: 0, bz: SPEAR_RANGE + 0.3, radius: 0.5 };
    const { hit } = runShot(fire({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }), [target]);
    expect(hit).not.toBeNull();
    expect(hit!.held).toBe(true);
    expect(hit!.impactSpeed).toBeGreaterThan(0);
    expect(hit!.impactSpeed).toBeLessThan(SPEAR_SPEED);
  });

  it('stepSpear with an rng can report held=false on a weak edge-of-range hit, and held=true is still possible at point-blank', () => {
    const farTarget: CapsuleTarget = { id: 'far', ax: 0, ay: 0, az: SPEAR_RANGE - 0.3, bx: 0, by: 0, bz: SPEAR_RANGE + 0.3, radius: 0.5 };
    // An rng that always returns just-under-1 fails every roll below the holdChance cap — a weak,
    // near-max-range hit (well under the 0.95 cap) must come back unheld.
    const alwaysFailsRoll = () => 0.999;
    let s = fire({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    let hit = null;
    for (let i = 0; i < 200 && s.alive && !hit; i++) {
      const r = stepSpear(s, [farTarget], DT, alwaysFailsRoll);
      s = r.shot; hit = r.hit;
    }
    expect(hit).not.toBeNull();
    expect(hit!.held).toBe(false);

    // An rng that always returns 0 passes every roll (as long as holdChance > 0) — a point-blank
    // hit (near-muzzle speed, holdChance near its 0.95 cap) comes back held.
    const closeTarget: CapsuleTarget = { id: 'close', ax: 0, ay: 0, az: 0.8, bx: 0, by: 0, bz: 1.2, radius: 0.5 };
    const alwaysPassesRoll = () => 0;
    let s2 = fire({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
    let hit2 = null;
    for (let i = 0; i < 200 && s2.alive && !hit2; i++) {
      const r = stepSpear(s2, [closeTarget], DT, alwaysPassesRoll);
      s2 = r.shot; hit2 = r.hit;
    }
    expect(hit2).not.toBeNull();
    expect(hit2!.held).toBe(true);
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
