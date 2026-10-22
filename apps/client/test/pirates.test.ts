/**
 * The pirates' approach and their visit (src/entities/life/pirates.ts, pirate-nav.ts).
 *
 * The 30-minute timer is never waited out: the controller takes `nowS`, so each test sets the
 * wall clock to a number and runs the visit in simulated seconds. The schedule's own maths
 * (spacing, late-joiner rule, line pools) is covered in packages/shared/test/pirates.test.ts;
 * what is under test here is everything that has to be true *about the approach*: that they
 * come from far off and from outside the view, stay on water, close monotonically, talk in
 * order, leave, and cost nothing when they are not there.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { chainZ } from '@keysrun/shared/world/chain';
import { depthAt } from '@keysrun/shared/world/depth';
import { pirateVisit, PIRATE_JOIN_GRACE_S } from '@keysrun/shared/world/pirates';
import { createPirates, type Pirates, type PirateLootSource } from '../src/entities/life/pirates.js';
import {
  HAIL_DIST, MIN_DEPTH, SAIL_SPEED, SPAWN_DIST, clearWater, headingTo, lineClear, placeSpawn, steerHeading,
  type ViewCone,
} from '../src/entities/life/pirate-nav.js';
import { SPAWN_X, SPAWN_DZ } from '../src/state/constants.js';

const SEED = 20240817;
const toasts: string[] = [];
const toastEl = {
  set textContent(v: string) { toasts.push(v); },
  get textContent() { return toasts[toasts.length - 1] ?? ''; },
  classList: { add() {}, remove() {} },
};
beforeAll(() => {
  (globalThis as Record<string, unknown>).document = {
    createElement: () => ({ className: '', style: {} as Record<string, string>, textContent: '', remove() {} }),
    getElementById: (id: string) => (id === 'toast' ? toastEl : null),
  };
});
afterAll(() => { delete (globalThis as Record<string, unknown>).document; });

const START = { x: SPAWN_X, z: chainZ(SPAWN_X) + SPAWN_DZ };
const particles = { spawnP() {}, splash() {} } as never;
const VIEW = { w: 1280, h: 800 };

function cameraAt(p: { x: number; z: number }, yaw = 0): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(60, 1.6, 0.1, 5000);
  c.position.set(p.x, 3, p.z);
  c.rotation.set(0, yaw, 0);
  c.updateMatrixWorld();
  return c;
}

const coneOf = (c: THREE.PerspectiveCamera): ViewCone => {
  const d = new THREE.Vector3(); c.getWorldDirection(d);
  const h = Math.hypot(d.x, d.z);
  return { fx: d.x / h, fz: d.z / h, half: Math.atan(Math.tan(THREE.MathUtils.degToRad(c.fov) / 2) * c.aspect) + 0.4 };
};

describe('where they come from', () => {
  const places: Array<[string, { x: number; z: number }]> = [
    ['the harbour start', START],
    ['off the Seven Mile Bridge', { x: 600, z: chainZ(600) + 330 }],
    ['out in Hawk Channel', { x: 1500, z: chainZ(1500) + 700 }],
    ['the Gulf side', { x: 350, z: chainZ(350) - 700 }],
  ];

  it('finds open water all the way to the player, far off, for both seas and both spreads', () => {
    for (const [name, p] of places) {
      for (const sea of ['gulf', 'channel'] as const) {
        for (const spread of [-0.9, -0.2, 0.3, 0.95]) {
          const sp = placeSpawn(p, sea, spread, null);
          expect(sp, `${name} ${sea} ${spread}`).not.toBeNull();
          expect(clearWater(sp!.x, sp!.z), `${name} spawn is wet`).toBe(true);
          const ux = (sp!.x - p.x) / sp!.dist, uz = (sp!.z - p.z) / sp!.dist;
          // all but the last ~60 m (a player on a flat is fine to sail up to; steering stops them at the shoal)
          expect(lineClear(sp!.x, sp!.z, p.x + ux * HAIL_DIST * 1.4, p.z + uz * HAIL_DIST * 1.4), `${name} line to player crosses land`).toBe(true);
          // "Approach from distance": at least a third of the nominal kilometre even for a cramped spot.
          expect(Math.hypot(sp!.x - p.x, sp!.z - p.z)).toBeGreaterThanOrEqual(SPAWN_DIST * 0.34 - 1);
          expect(Math.hypot(sp!.x - p.x, sp!.z - p.z)).toBeCloseTo(sp!.dist, 3);
        }
      }
    }
  });

  it('puts the spawn outside the camera cone whenever any bearing allows it', () => {
    let outside = 0, total = 0;
    for (const [, p] of places) {
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const cone = coneOf(cameraAt(p, yaw));
        for (const sea of ['gulf', 'channel'] as const) {
          const sp = placeSpawn(p, sea, 0.1, cone);
          expect(sp).not.toBeNull();
          total++;
          const dx = sp!.x - p.x, dz = sp!.z - p.z, d = Math.hypot(dx, dz);
          const ang = Math.acos((dx * cone.fx + dz * cone.fz) / d);
          if (ang >= cone.half) outside++;
        }
      }
    }
    // Land blocks some bearings (a bay start looking at the only open water), but the common case
    // must be out of view; anything lower means the preference pass is broken.
    expect(outside / total).toBeGreaterThan(0.85);
  });

  it('is deterministic: same player, same visit, same spot', () => {
    expect(placeSpawn(START, 'gulf', 0.4, null)).toEqual(placeSpawn(START, 'gulf', 0.4, null));
  });
});

describe('sailing there', () => {
  it('steers off shoals instead of over them', () => {
    // Aim a boat at a point across a key and check it never picks a wet-to-dry heading.
    const x = 600, z = chainZ(600) + 60;
    expect(depthAt(x, z)).toBeLessThan(MIN_DEPTH + 40); // sanity: somewhere near shore
    for (let a = 0; a < 6.28; a += 0.2) {
      const h = steerHeading(x, z, a);
      if (h === null) continue;
      expect(clearWater(x - Math.sin(h) * 46, z - Math.cos(h) * 46)).toBe(true);
    }
  });

  it('headingTo and forward agree with the hull convention (bow down -z)', () => {
    const h = headingTo(30, -40);
    expect(-Math.sin(h)).toBeGreaterThan(0);
    expect(-Math.cos(h)).toBeLessThan(0);
  });
});

// ------------------------------------------------------------------ the controller

let scene: THREE.Scene;
let now = 0;
let pirates: Pirates;
let cash = 0;
let cooler: Pick<PirateLootSource, 'coolerLb' | 'coolerCount'> = { coolerLb: 0, coolerCount: 0 };
const DT = 0.25;

function build(): void {
  scene = new THREE.Scene();
  toasts.length = 0;
  pirates = createPirates(scene, {
    nowS: () => now, seed: SEED,
    loot: () => ({ cash, ...cooler, boatId: 'grady', boat: 'Grady-White Actively Sinking' }),
  });
}

interface Trace { phases: string[]; dists: number[]; xz: Array<[number, number]>; maxStep: number }

/** Runs `secs` of simulated time with the player sitting still at START. */
function run(secs: number, t0 = 0, player = START, cam = cameraAt(START, 0)): { t: number; tr: Trace } {
  const tr: Trace = { phases: [], dists: [], xz: [], maxStep: 0 };
  let t = t0;
  for (let i = 0; i < Math.round(secs / DT); i++) {
    t += DT;
    pirates.update(DT, t, { x: player.x, y: 0.4, z: player.z }, cam, VIEW, particles, 0.2);
    const dbg = pirates.debug();
    if (dbg.phase === 'away' && !tr.phases.length) continue;
    if (tr.phases[tr.phases.length - 1] !== dbg.phase) tr.phases.push(dbg.phase);
    if (dbg.phase !== 'away' && dbg.dist > 0) {
      tr.dists.push(dbg.dist);
      const last = tr.xz[tr.xz.length - 1];
      if (last) tr.maxStep = Math.max(tr.maxStep, Math.hypot(dbg.x - last[0], dbg.z - last[1]));
      tr.xz.push([dbg.x, dbg.z]);
    }
  }
  return { t, tr };
}

beforeEach(() => { cash = 0; cooler = { coolerLb: 0, coolerCount: 0 }; build(); });

describe('while they are away', () => {
  it('costs nothing: no hull, no crew, no scene object, no audio site, no toasts', () => {
    const v = pirateVisit(SEED, 700);
    now = v.start - 600;
    const { tr } = run(120);
    expect(tr.phases).toEqual([]);
    expect(scene.children.length).toBe(0);
    expect(pirates.site()).toBeNull();
    expect(pirates.phase()).toBe('away');
    expect(toasts).toEqual([]);
  });

  it('does not let a visit you joined late appear out of nowhere', () => {
    const v = pirateVisit(SEED, 700);
    now = v.start + PIRATE_JOIN_GRACE_S + 20;
    const { tr } = run(60);
    expect(tr.phases).toEqual([]);
    expect(scene.children.length).toBe(0);
    // ...and it is written off, so it does not fire later in the same bucket either.
    now = v.start + 400;
    run(30);
    expect(pirates.phase()).toBe('away');
    expect(pirates.debug().handled).toBe(700);
  });
});

describe('a visit, start to finish', () => {
  it('arrives from far off, outside the view, over water, and never pops in', () => {
    const v = pirateVisit(SEED, 700);
    now = v.start + 2;
    const cam = cameraAt(START, 0);
    const cone = coneOf(cam);
    pirates.update(DT, 1, { x: START.x, y: 0.4, z: START.z }, cam, VIEW, particles, 0.2);
    const d0 = pirates.debug();
    expect(d0.phase).toBe('approach');
    expect(d0.spawnDist).toBeGreaterThanOrEqual(SPAWN_DIST * 0.34 - 1);
    const dx = d0.x - START.x, dz = d0.z - START.z;
    expect(Math.acos((dx * cone.fx + dz * cone.fz) / Math.hypot(dx, dz))).toBeGreaterThanOrEqual(cone.half);
    expect(clearWater(d0.x, d0.z)).toBe(true);
    expect(toasts.join('\n')).toMatch(/bell/i); // the herald
  });

  it('closes monotonically, stays on water, never teleports, hails, banters, leaves, and cleans up', () => {
    cash = 4321;
    const v = pirateVisit(SEED, 700);
    now = v.start + 2;
    const { tr } = run(800);
    // order of phases, ending away
    expect(tr.phases).toEqual(['approach', 'linger', 'depart', 'away']);
    // every position was wet
    for (const [x, z] of tr.xz) expect(clearWater(x, z), `dry at ${x},${z}`).toBe(true);
    // no teleports: a boat doing 6.5 m/s moves under 2 m in a 0.25 s step
    expect(tr.maxStep).toBeLessThan(SAIL_SPEED * DT * 1.3);
    // closing: from the first frame to the nearest point, distance falls and does so steadily
    const minI = tr.dists.indexOf(Math.min(...tr.dists));
    expect(tr.dists[0]).toBeGreaterThan(450);
    for (let i = 20; i < minI; i++) expect(tr.dists[i]).toBeLessThanOrEqual(tr.dists[i - 20] + 3);
    // hove to near HAIL_DIST, not on top of the player, not still a hundred metres off
    expect(Math.min(...tr.dists)).toBeGreaterThan(HAIL_DIST * 0.6);
    expect(Math.min(...tr.dists)).toBeLessThan(HAIL_DIST * 1.5);
    // and gone at the end: out of the scene, no site
    expect(scene.children.length).toBe(0);
    expect(pirates.site()).toBeNull();
    expect(pirates.debug().handled).toBe(700);
    // the exchange: the pirate toasts, in order, reading the player's cash
    const talk = toasts.filter((m) => m.includes('Cap’n Barnacle') || m.includes("Cap'n Barnacle") || m.includes('Mr. Mildew'));
    expect(talk.length).toBeGreaterThanOrEqual(6);
    expect(talk.filter((m) => m.includes('Mr. Mildew')).length).toBeGreaterThanOrEqual(2);
    expect(toasts.some((m) => m.includes('bearing down'))).toBe(true);
  });

  it('reads the cooler and the wallet: a full cooler and a fat wallet get different verdicts', () => {
    const verdictFor = (c: number, lb: number, n: number): string => {
      build();
      cash = c; cooler = { coolerLb: lb, coolerCount: n };
      now = pirateVisit(SEED, 700).start + 2;
      run(500);
      return toasts.filter((m) => /Barnacle|Mildew/.test(m))[2] ?? '';
    };
    const broke = verdictFor(0, 0, 0);
    const rich = verdictFor(77_000, 0, 0);
    const haul = verdictFor(0, 300, 11);
    expect(rich).toContain('$77,000');
    expect(haul).toMatch(/300|stuffed|haul/i);
    expect(new Set([broke, rich, haul]).size).toBe(3);
  });

  it('fires once per bucket, and again for the next one with different banter', () => {
    now = pirateVisit(SEED, 700).start + 2;
    const first = run(800);
    const firstTalk = toasts.filter((m) => /Barnacle|Mildew/.test(m)).join('|');
    // same bucket, much later: nothing
    now = pirateVisit(SEED, 700).start + 500;
    run(30, first.t);
    expect(pirates.phase()).toBe('away');
    // next bucket's visit
    toasts.length = 0;
    now = pirateVisit(SEED, 701).start + 2;
    const second = run(800, first.t);
    expect(second.tr.phases).toEqual(['approach', 'linger', 'depart', 'away']);
    expect(toasts.filter((m) => /Barnacle|Mildew/.test(m)).join('|')).not.toBe(firstTalk);
  });

  it('exposes an audio site only while they are here, and it follows the boat', () => {
    now = pirateVisit(SEED, 700).start + 2;
    expect(pirates.site()).toBeNull();
    run(10);
    const s = pirates.site()!;
    expect(s).not.toBeNull();
    const d = pirates.debug();
    expect(s.x).toBeCloseTo(d.x, 0);
    expect(s.z).toBeCloseTo(d.z, 0);
    run(800, 10);
    expect(pirates.site()).toBeNull();
  });

  it('can be summoned for verification without touching the clock or the schedule', () => {
    now = pirateVisit(SEED, 700).start - 900; // nowhere near due
    pirates.update(DT, 0, { x: START.x, y: 0.4, z: START.z }, cameraAt(START, 0), VIEW, particles, 0.2);
    const handledBefore = pirates.debug().handled;
    pirates.summon(300);
    run(1);
    expect(pirates.phase()).toBe('approach');
    expect(pirates.debug().spawnDist).toBeGreaterThan(100);
    run(500, 1);
    expect(pirates.phase()).toBe('away');
    expect(pirates.debug().handled).toBe(handledBefore); // a summon does not eat the real visit
  });

  it('gives up cleanly on a player who outruns them, rather than chasing forever', () => {
    now = pirateVisit(SEED, 700).start + 2;
    const cam = cameraAt(START, 0);
    let t = 0;
    let p = { ...START };
    const phases = new Set<string>();
    // The player races east at 25 m/s for 8 simulated minutes.
    for (let i = 0; i < 1920; i++) {
      t += DT; p = { x: p.x + 25 * DT, z: p.z };
      if (depthAt(p.x, p.z) < 4) p = { x: p.x, z: p.z + 25 * DT * 0.5 };
      pirates.update(DT, t, { x: p.x, y: 0.4, z: p.z }, cam, VIEW, particles, 0.2);
      phases.add(pirates.phase());
    }
    // Whatever it did, it is not still sailing after eight minutes: the visit is bounded.
    run(300, t, p, cam);
    expect(pirates.phase()).toBe('away');
  });
});
