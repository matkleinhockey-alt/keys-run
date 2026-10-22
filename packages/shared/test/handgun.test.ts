/**
 * The boat pistol's ballistics and hit resolution (sim/handgun.ts). Everything here is pure, so
 * these are plain numeric facts about a bullet, a magazine and the water - not screenshots.
 *
 * The claims in sim/handgun.ts's header ("a fish 0.6 m down needs ~1.3 m of bullet-in-water at 28
 * degrees") are asserted below, so a change to WATER_STOP_M that breaks the gameplay promise fails
 * here rather than in somebody's playthrough.
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/rng/index.js';
import {
  fireBullet, stepBullet, aimBullet, spreadDir, spreadFor, createGun, canFire, pullTrigger, startReload, stepGun,
  takeRounds, reserveRounds, magSizeFor, ammoNotice, gunshotSpooks, birdAwaySeconds, minAirDistTo, fishWithinReach,
  birdScatterChance, MAG_SIZE, FIRE_INTERVAL, RELOAD_S, RELOAD_EMPTY_S, WATER_STOP_M, SKIP_ANGLE, ENERGY_STUN, MUZZLE_SPEED,
  BULLET_RANGE, ASSIST_CONE, FISH_SPOOK_S, SPREAD_BASE, SPREAD_PER_HEAT, AMMO_KEY, EXTMAG_KEY, DOT_KEY,
  type BulletState, type BulletTarget, type BulletEnv, type GunState,
} from '../src/sim/handgun.js';
import { emptyInventory, startingInventory, buy, countOf, modifiersFor, NO_MODIFIERS } from '../src/sim/shop.js';

const FLAT: BulletEnv = { surfaceY: () => 0 };
const DT = 1 / 30;

/** Runs a bullet to the end (or `maxS`), returning the final state, first hit and all events. */
function fly(b0: BulletState, targets: BulletTarget[], env: BulletEnv = FLAT, maxS = 3) {
  let b = b0;
  const events = [] as ReturnType<typeof stepBullet>['events'];
  for (let t = 0; t < maxS && b.alive; t += DT) {
    const r = stepBullet(b, targets, DT, env);
    b = r.bullet; events.push(...r.events);
    if (r.hit) return { b, hit: r.hit, events };
  }
  return { b, hit: null, events };
}

/** Unit vector `deg` degrees below the horizon, toward -z. */
const down = (deg: number) => ({ x: 0, y: -Math.sin((deg * Math.PI) / 180), z: -Math.cos((deg * Math.PI) / 180) });

const capsuleAt = (id: string, x: number, y: number, z: number, r = 0.15, half = 0.25): BulletTarget =>
  ({ id, ax: x, ay: y, az: z - half, bx: x, by: y, bz: z + half, radius: r });

/** A fish `depth` m below the surface, at the point a bullet fired from (0, h, 0) at `deg` below
 * horizontal reaches that depth. */
function fishOnPath(h: number, deg: number, depth: number, r = 0.2): { t: BulletTarget; range: number } {
  const range = (h + depth) / Math.tan((deg * Math.PI) / 180);
  return { t: capsuleAt('fish', 0, -depth, -range, r, 0.3), range };
}

describe('flight in air', () => {
  it('keeps most of its speed and barely drops over a boat-sized shot', () => {
    const { b } = fly(fireBullet({ x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: -1 }), [], { surfaceY: () => -50 }, 0.1);
    // 0.1 s at ~330 m/s is ~33 m of path; gravity drops it g t^2 / 2 = 4.9 cm.
    expect(-b.z).toBeGreaterThan(30);
    expect(2 - b.y).toBeLessThan(0.08);
    expect(Math.hypot(b.vx, b.vy, b.vz)).toBeGreaterThan(MUZZLE_SPEED * 0.9);
  });

  it('is retired at BULLET_RANGE rather than flying forever', () => {
    const r = fly(fireBullet({ x: 0, y: 500, z: 0 }, { x: 0, y: 0, z: -1 }), [], { surfaceY: () => -1e6 }, 5);
    expect(r.b.alive).toBe(false);
    expect(r.b.travelled).toBeGreaterThanOrEqual(BULLET_RANGE);
  });

  it('is independent of the tick rate it is stepped at', () => {
    const gull = [capsuleAt('gull', 1.0, 6, -40, 0.45, 0.3)];
    const dir = { x: 1 / 40, y: 4 / 40, z: -1 };
    const run = (dt: number, n: number) => {
      let b = fireBullet({ x: 0, y: 2, z: 0 }, dir);
      for (let i = 0; i < n && b.alive; i++) { const r = stepBullet(b, gull, dt, FLAT); b = r.bullet; if (r.hit) return r.hit; }
      return null;
    };
    const a = run(1 / 30, 40), c = run(1 / 60, 80);
    expect(a).not.toBeNull();
    expect(c).not.toBeNull();
    expect(Math.hypot(a!.point.x - c!.point.x, a!.point.y - c!.point.y, a!.point.z - c!.point.z)).toBeLessThan(0.05);
  });
});

describe('hitting birds', () => {
  const gull = capsuleAt('gull', 0, 8, -30, 0.45, 0.3);
  const aimAt = (tx: number, ty: number, tz: number) => { const l = Math.hypot(tx, ty - 2, tz); return { x: tx / l, y: (ty - 2) / l, z: tz / l }; };

  it('hits a gull it is aimed at', () => {
    const r = fly(fireBullet({ x: 0, y: 2, z: 0 }, aimAt(0, 8.05, -30)), [gull]);
    expect(r.hit?.id).toBe('gull');
    expect(r.hit?.inWater).toBe(false);
    expect(r.hit!.energy).toBeGreaterThan(0.8);
  });

  it('misses it when aimed a metre and a bit off', () => {
    const r = fly(fireBullet({ x: 0, y: 2, z: 0 }, aimAt(1.2, 8, -30)), [gull]);
    expect(r.hit).toBeNull();
  });

  it('a non-catchable target (a dolphin) is never hit', () => {
    const r = fly(fireBullet({ x: 0, y: 2, z: 0 }, aimAt(0, 8.05, -30)), [{ ...gull, catchable: false }]);
    expect(r.hit).toBeNull();
  });

  it('hits the nearer of two birds in line', () => {
    const near = capsuleAt('near', 0, 5.0, -15, 0.45, 0.3); // on the same line of sight (y = 2 + 6.05 * 15/30)
    const r = fly(fireBullet({ x: 0, y: 2, z: 0 }, aimAt(0, 8.05, -30)), [gull, near]);
    expect(r.hit?.id).toBe('near');
  });
});

describe('water stops a bullet fast', () => {
  it('a steep shot reaches a fish just under the surface', () => {
    const { t } = fishOnPath(2.5, 35, 0.3);
    const r = fly(fireBullet({ x: 0, y: 2.5, z: 0 }, down(35)), [t]);
    expect(r.hit?.id).toBe('fish');
    expect(r.hit!.inWater).toBe(true);
    expect(r.hit!.energy).toBeGreaterThan(ENERGY_STUN);
    expect(r.hit!.depth).toBeGreaterThan(0.1);
  });

  it('cannot reach a fish three metres down at ANY angle', () => {
    for (const deg of [15, 25, 40, 60, 85]) {
      const { t } = fishOnPath(2.5, deg, 3, 0.4);
      const r = fly(fireBullet({ x: 0, y: 2.5, z: 0 }, down(deg)), [t]);
      expect(r.hit, `${deg} deg`).toBeNull();
      expect(r.b.alive, `${deg} deg`).toBe(false);
      expect(r.b.waterPath, `${deg} deg`).toBeLessThanOrEqual(WATER_STOP_M + 1e-6);
    }
  });

  it('cannot snipe a 10 m deep fish straight down either', () => {
    const t = capsuleAt('deep', 0, -10, 0, 0.5, 0.5);
    const r = fly(fireBullet({ x: 0, y: 2.5, z: 0 }, { x: 0, y: -1, z: 0 }), [t]);
    expect(r.hit).toBeNull();
    expect(r.b.y).toBeGreaterThan(-WATER_STOP_M - 0.01);
  });

  it('the same fish is reachable steeply but not shallowly - path length, not depth, is what stops it', () => {
    // 0.9 m down: ~2.2 m of path at 24 degrees (energy gone), ~1.0 m at 60 (still plenty).
    const steep = fishOnPath(2.5, 60, 0.9), shallow = fishOnPath(2.5, 14, 0.9);
    const a = fly(fireBullet({ x: 0, y: 2.5, z: 0 }, down(60)), [steep.t]);
    const c = fly(fireBullet({ x: 0, y: 2.5, z: 0 }, down(14)), [shallow.t]);
    expect(a.hit?.id).toBe('fish');
    expect(c.hit).toBeNull();
  });

  it('energy at a water hit falls as the remaining-speed fraction squared', () => {
    // Straight down, fish centred 1.0 m under: path ~0.9-1.1 m of 2.4 -> energy ~ (1 - 1/2.4)^2 = 0.34.
    const t = capsuleAt('f', 0, -1.0, 0, 0.12, 0.12);
    const r = fly(fireBullet({ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }), [t]);
    expect(r.hit).not.toBeNull();
    expect(r.hit!.energy).toBeGreaterThan(ENERGY_STUN);
    expect(r.hit!.energy).toBeLessThan(0.6);
  });

  it('emits a splash where it enters', () => {
    const r = fly(fireBullet({ x: 0, y: 2.5, z: 0 }, down(30)), []);
    const splash = r.events.find((e) => e.kind === 'splash');
    expect(splash).toBeDefined();
    expect(splash!.y).toBeCloseTo(0, 1);
    expect(-splash!.z).toBeCloseTo(2.5 / Math.tan((30 * Math.PI) / 180), 0);
  });

  it('follows the wave surface, not y = 0', () => {
    const r = fly(fireBullet({ x: 0, y: 2.5, z: 0 }, down(30)), [], { surfaceY: () => 1.0 });
    const splash = r.events.find((e) => e.kind === 'splash')!;
    expect(splash.y).toBeCloseTo(1.0, 1);
  });
});

describe('ricochet', () => {
  it('a grazing shot skips off the water and stays in the air', () => {
    const r = fly(fireBullet({ x: 0, y: 2, z: 0 }, down(2)), []);
    expect(r.events.some((e) => e.kind === 'skip')).toBe(true);
    expect(r.b.skips).toBe(1);
    expect(SKIP_ANGLE).toBeGreaterThan((2 * Math.PI) / 180);
  });

  it('a shot just steeper than the threshold enters instead', () => {
    const r = fly(fireBullet({ x: 0, y: 2, z: 0 }, down(7)), []);
    expect(r.events.some((e) => e.kind === 'skip')).toBe(false);
    expect(r.events.some((e) => e.kind === 'splash')).toBe(true);
  });

  it('a skipped bullet can still hit a bird beyond the skip', () => {
    const r0 = fly(fireBullet({ x: 0, y: 2, z: 0 }, down(2)), []);
    const skip = r0.events.find((e) => e.kind === 'skip')!;
    const bird = capsuleAt('low-gull', 0, 1.0, skip.z - 12, 1.5, 0.4);
    const r = fly(fireBullet({ x: 0, y: 2, z: 0 }, down(2)), [bird]);
    expect(r.hit?.id).toBe('low-gull');
    expect(r.hit!.inWater).toBe(false);
  });

  it('skips at most once - a second graze ends it', () => {
    // Fired just above a flat sea, almost level, then pushed back down by gravity into a second graze.
    const r = fly(fireBullet({ x: 0, y: 0.4, z: 0 }, { x: 0, y: -0.004, z: -1 }), [], FLAT, 2);
    expect(r.b.skips).toBeLessThanOrEqual(1);
    expect(r.b.alive).toBe(false);
  });
});

describe('ground', () => {
  it('stops at an island', () => {
    const r = fly(fireBullet({ x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: -1 }), [], { surfaceY: () => 0, groundY: (_x, z) => (z < -20 ? 3 : -2) });
    expect(r.events.some((e) => e.kind === 'thud')).toBe(true);
    expect(r.b.alive).toBe(false);
  });
});

describe('air legs (what Caelen is tested against)', () => {
  it('records one leg origin -> water entry, and nothing for the underwater part', () => {
    const r = fly(fireBullet({ x: 0, y: 2.5, z: 0 }, down(30)), []);
    expect(r.b.legs).toHaveLength(1);
    expect(r.b.legs[0][1].y).toBeCloseTo(0, 1);
  });

  it('measures the closest approach of the air path to a point', () => {
    const r = fly(fireBullet({ x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: -1 }), [], { surfaceY: () => -10 }, 0.5);
    const d = minAirDistTo(r.b, { x: 1.5, y: 2, z: -30 }, { x: 1.5, y: 2, z: -29 });
    expect(d).toBeGreaterThan(1.4);
    expect(d).toBeLessThan(1.7);
  });
});

describe('the gun', () => {
  it('fires a magazine, then clicks', () => {
    let g: GunState = createGun();
    expect(g.mag).toBe(MAG_SIZE);
    let fired = 0;
    for (let i = 0; i < MAG_SIZE + 3; i++) {
      const r = pullTrigger(g);
      g = stepGun(r.gun, FIRE_INTERVAL + 0.01, MAG_SIZE, () => 0);
      if (r.result === 'fired') fired++;
    }
    expect(fired).toBe(MAG_SIZE);
    expect(g.mag).toBe(0);
    expect(pullTrigger(g).result).toBe('empty');
  });

  it('will not fire faster than FIRE_INTERVAL, and says "busy" rather than "empty"', () => {
    const a = pullTrigger(createGun());
    expect(a.result).toBe('fired');
    expect(canFire(a.gun)).toBe(false);
    expect(pullTrigger(a.gun).result).toBe('busy');
    expect(canFire(stepGun(a.gun, FIRE_INTERVAL, MAG_SIZE, () => 0))).toBe(true);
  });

  it('a reload takes longer from empty, asks for exactly the shortfall, and only once', () => {
    const wants: number[] = [];
    const partial = { ...createGun(), mag: 5 };
    let g = startReload(partial, MAG_SIZE, 100).gun;
    expect(g.reloadT).toBe(RELOAD_S);
    for (let t = 0; t < RELOAD_S + 0.2; t += 0.05) g = stepGun(g, 0.05, MAG_SIZE, (w) => { wants.push(w); return w; });
    expect(wants).toEqual([MAG_SIZE - 5]);
    expect(g.mag).toBe(MAG_SIZE);
    expect(g.reloading).toBe(false);
    expect(startReload({ ...createGun(), mag: 0 }, MAG_SIZE, 100).gun.reloadT).toBe(RELOAD_EMPTY_S);
  });

  it('cannot fire mid-reload, and a short reserve loads what there is', () => {
    let g = startReload({ ...createGun(), mag: 0 }, MAG_SIZE, 4).gun;
    expect(pullTrigger(g).result).toBe('busy');
    g = stepGun(g, RELOAD_EMPTY_S + 0.01, MAG_SIZE, (w) => Math.min(w, 4));
    expect(g.mag).toBe(4);
  });

  it('refuses to start a pointless reload (full mag, or nothing to load)', () => {
    expect(startReload(createGun(), MAG_SIZE, 50).started).toBe(false);
    expect(startReload({ ...createGun(), mag: 0 }, MAG_SIZE, 0).started).toBe(false);
  });

  it('the hand gets shaky with rapid fire and settles', () => {
    let g = createGun();
    const base = spreadFor(g);
    for (let i = 0; i < 4; i++) g = stepGun(pullTrigger(stepGun(g, FIRE_INTERVAL, MAG_SIZE, () => 0)).gun, 0.001, MAG_SIZE, () => 0);
    expect(spreadFor(g)).toBeGreaterThan(base * 1.8);
    g = stepGun(g, 3, MAG_SIZE, () => 0);
    expect(spreadFor(g)).toBeCloseTo(SPREAD_BASE, 6);
    expect(spreadFor({ ...g, heat: 1 })).toBeCloseTo(SPREAD_BASE + SPREAD_PER_HEAT, 6);
  });
});

describe('spread', () => {
  it('stays inside its cone, uniformly over the disc', () => {
    const rng = mulberry32(7);
    const dir = { x: 0.3, y: 0.2, z: -0.9 };
    const l = Math.hypot(dir.x, dir.y, dir.z);
    let inner = 0;
    const N = 4000, spread = 0.03;
    for (let i = 0; i < N; i++) {
      const d = spreadDir(dir, spread, rng);
      const ang = Math.acos((d.x * dir.x + d.y * dir.y + d.z * dir.z) / l);
      expect(ang).toBeLessThanOrEqual(spread * 1.0001);
      if (ang < spread / Math.SQRT2) inner++;
    }
    // Uniform disc: half the area is inside r / sqrt(2).
    expect(inner / N).toBeGreaterThan(0.46);
    expect(inner / N).toBeLessThan(0.54);
  });

  it('is exact with zero spread', () => {
    const d = spreadDir({ x: 0, y: 0, z: -2 }, 0, mulberry32(1));
    expect(d).toEqual({ x: 0, y: 0, z: -1 });
  });
});

describe('aiming', () => {
  const eye = { x: 0, y: 2.5, z: 0 }, muzzle = { x: 0.2, y: 2.3, z: -0.6 };

  it('with nothing to lock, converges the barrel on the crosshair at 30 m', () => {
    const a = aimBullet(muzzle, eye, { x: 0, y: 0, z: -1 }, []);
    expect(a.targetId).toBeNull();
    // Fly it and read the lateral / vertical offset where it crosses z = -30 (the crosshair line is
    // x = 0, y = 2.5 there, less ~5 cm of drop that the aim pre-compensates).
    let b = fireBullet(muzzle, { x: a.dx, y: a.dy, z: a.dz });
    const env: BulletEnv = { surfaceY: () => -100 };
    while (b.alive && b.z > -30) b = stepBullet(b, [], DT / 4, env).bullet;
    expect(Math.abs(b.x)).toBeLessThan(0.06);
    expect(Math.abs(b.y - 2.5)).toBeLessThan(0.1);
  });

  it('locks onto a target in the cone and not one outside it', () => {
    const inside = capsuleAt('in', 1, 2.5, -20, 0.3);
    const outside = capsuleAt('out', 9, 2.5, -20, 0.3);
    expect(aimBullet(muzzle, eye, { x: 0, y: 0, z: -1 }, [outside]).targetId).toBeNull();
    const a = aimBullet(muzzle, eye, { x: 0, y: 0, z: -1 }, [inside, outside]);
    expect(a.targetId).toBe('in');
    expect(a.applied).toBeGreaterThan(0);
    expect(a.applied).toBeLessThan(ASSIST_CONE * 1.5);
  });

  it('never locks a non-catchable target, and leads a moving one', () => {
    expect(aimBullet(muzzle, eye, { x: 0, y: 0, z: -1 }, [{ ...capsuleAt('dolphin', 0, 2.5, -20), catchable: false }]).targetId).toBeNull();
    const still = aimBullet(muzzle, eye, { x: 0.05, y: 0, z: -1 }, [capsuleAt('b', 0, 2.5, -30, 0.5)]);
    const moving = aimBullet(muzzle, eye, { x: 0.05, y: 0, z: -1 }, [{ ...capsuleAt('b', 0, 2.5, -30, 0.5), vx: 12 }]);
    expect(moving.dx).toBeGreaterThan(still.dx);
  });

  it('assist: false is the plain converged shot', () => {
    const t = capsuleAt('in', 1, 2.5, -20, 0.3);
    expect(aimBullet(muzzle, eye, { x: 0, y: 0, z: -1 }, [t], { assist: false }).targetId).toBeNull();
  });

  it('does not offer fish the water would refuse', () => {
    expect(fishWithinReach(-0.4, 0)).toBe(true);
    expect(fishWithinReach(-4, 0)).toBe(false);
  });
});

describe('measured hit rates', () => {
  // The rates quoted in the task report. Fixed seed, so they are reproducible, and asserted
  // loosely enough to survive a tuning nudge but tightly enough to catch a model that stopped
  // working (e.g. spread applied twice, or the water gate removed).
  const eye = { x: 0, y: 2.5, z: 0 }, muzzle = { x: 0.15, y: 2.35, z: -0.5 };
  const rate = (tgt: BulletTarget, n: number, heat = 0, spreadMul = 1): number => {
    const rng = mulberry32(42);
    let hits = 0;
    for (let i = 0; i < n; i++) {
      const c = { x: (tgt.ax + tgt.bx) / 2, y: (tgt.ay + tgt.by) / 2, z: (tgt.az + tgt.bz) / 2 };
      const l = Math.hypot(c.x - eye.x, c.y - eye.y, c.z - eye.z);
      const aim = { x: (c.x - eye.x) / l, y: (c.y - eye.y) / l, z: (c.z - eye.z) / l };
      const a = aimBullet(muzzle, eye, aim, [tgt]);
      const sp = spreadDir({ x: a.dx, y: a.dy, z: a.dz }, spreadFor({ ...createGun(), heat }, spreadMul), rng);
      if (fly(fireBullet(muzzle, sp), [tgt]).hit) hits++;
    }
    return hits / n;
  };

  it('a gull at 25 m is a fair shot, a typical surface fish (centre 0.6 m down) at 5 m is easy, the same fish at 12 m is out of reach', () => {
    const gull = rate(capsuleAt('g', 0, 9, -25, 0.45, 0.3), 400);
    const fishNear = rate(capsuleAt('f', 0, -0.6, -5, 0.15, 0.3), 400);
    const fishFar = rate(capsuleAt('f', 0, -0.6, -12, 0.15, 0.3), 400);
    console.log('hit rates  gull25=%s  fish5m=%s  fish12m=%s', gull.toFixed(2), fishNear.toFixed(2), fishFar.toFixed(2));
    expect(gull).toBeGreaterThan(0.8);
    expect(fishNear).toBeGreaterThan(0.7);
    expect(fishFar).toBe(0); // 13 degrees: 1.9 m of bullet-in-water to its back, and the water gives up at ~1.3
  });

  it('a fish at 1.5 m depth is out of reach at every range', () => {
    expect(rate(capsuleAt('f', 0, -1.5, -4, 0.2, 0.3), 200)).toBe(0);
  });

  it('a sloppy hand (full heat) costs hits on a small bird at range, the red dot gives them back', () => {
    const t = capsuleAt('tern', 0, 7, -45, 0.35, 0.25);
    const shaky = rate(t, 500, 1), steady = rate(t, 500, 0), dot = rate(t, 500, 1, 0.55);
    console.log('hit rates  tern45: shaky=%s steady=%s shaky+dot=%s', shaky.toFixed(2), steady.toFixed(2), dot.toFixed(2));
    expect(steady).toBeGreaterThan(shaky);
    expect(dot).toBeGreaterThan(shaky);
  });
});

describe('consequences', () => {
  it('a shot spooks under the shooter, and along the line to where it landed', () => {
    const s = gunshotSpooks({ x: 0, z: 0 }, { x: 0, z: -40 });
    expect(s[0]).toEqual({ x: 0, z: 0, ttl: FISH_SPOOK_S });
    expect(s.length).toBeGreaterThanOrEqual(5);
    expect(s.some((p) => p.z === -40)).toBe(true);
    expect(s.every((p) => p.ttl > 0)).toBe(true);
  });

  it("a shot into the air still spooks the shooter's own water", () => {
    expect(gunshotSpooks({ x: 5, z: 5 }, null)).toHaveLength(1);
  });

  it('a struck bird stays away longer than a startled one, and big birds sulk longest', () => {
    expect(birdAwaySeconds('gull', true)).toBeGreaterThan(birdAwaySeconds('gull', false));
    expect(birdAwaySeconds('pelican', true)).toBeGreaterThan(birdAwaySeconds('gull', true));
    expect(birdAwaySeconds('gull', false)).toBeGreaterThan(10);
  });
});

describe('scattering', () => {
  it('a bird the bullet cracked past always goes; one far from everything usually does not', () => {
    expect(birdScatterChance(30, 2)).toBeGreaterThan(0.8);
    expect(birdScatterChance(100, 60)).toBeLessThan(0.25);
    expect(birdScatterChance(500, 400)).toBe(0);
    expect(birdScatterChance(10, 40)).toBeGreaterThan(birdScatterChance(100, 40));
  });
});

describe('ammunition and the shop', () => {
  it('a new player starts with a couple of magazines, so the gun works out of the box', () => {
    expect(reserveRounds(startingInventory())).toBeGreaterThanOrEqual(2 * MAG_SIZE);
  });

  it('a box is 50 rounds, and reloading spends them', () => {
    const bought = buy(emptyInventory(), 'guns', 'pistol-ammo', 1e6, 0);
    expect(bought.ok).toBe(true);
    expect(countOf(bought.inventory, AMMO_KEY)).toBe(50);
    const t = takeRounds(bought.inventory, 12);
    expect(t.taken).toBe(12);
    expect(reserveRounds(t.inventory)).toBe(38);
    expect(takeRounds(emptyInventory(), 12).taken).toBe(0);
  });

  it('an extended magazine and a red dot each change the numbers the gun uses', () => {
    const mag = buy(emptyInventory(), 'guns', 'pistol-extmag', 1e6, 0).inventory;
    const dot = buy(emptyInventory(), 'guns', 'pistol-dot', 1e6, 0).inventory;
    expect(mag.gear).toContain(EXTMAG_KEY);
    expect(dot.gear).toContain(DOT_KEY);
    expect(magSizeFor(modifiersFor(mag, 0))).toBe(MAG_SIZE + 6);
    expect(magSizeFor(NO_MODIFIERS)).toBe(MAG_SIZE);
    expect(modifiersFor(dot, 0).handgunSpreadMul).toBeLessThan(1);
    expect(spreadFor(createGun(), modifiersFor(dot, 0).handgunSpreadMul)).toBeLessThan(spreadFor(createGun()));
  });

  it('says the right thing when dry', () => {
    expect(ammoNotice(0, 0)).toMatch(/Out of 9 mm/);
    expect(ammoNotice(0, 20)).toMatch(/Reload/);
    expect(ammoNotice(8, 20)).toBeNull();
  });
});
