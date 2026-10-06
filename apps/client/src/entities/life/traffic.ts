/**
 * Ambient boat traffic: center consoles, sportfishers, sailboats, go-fast wake boats (one with a
 * surfer riding the push off the stern quarter) and jet skis, 23 boats across 14 named routes.
 *
 * Ported faithfully from legacy/index.html:1804-1949 (`routeFrom`→`entities/life/path.ts`'s
 * `pointRoute`, `trafficHull`, `makeTraffic`, `TRAFFIC_DEF`, `ROUTES`, `updateTraffic`).
 *
 * Same wake caveat as racers.ts: no shared visual wake-ripple pool exists any more (see that
 * module's header), so traffic throws particle spray/wake but doesn't ripple the water shader.
 */
import * as THREE from 'three';
import { chainRoute, pointRoute, angLerp, type Path } from './path.js';
import { createHumanRegistry } from './human.js';
import { beamBetween, buildHullGeo, type HullGeoOptions } from '../boat/hull.js';
import { HULLS, type HullSpec, type HullColors } from '@keysrun/shared/content/boats';
import { chainZ } from '@keysrun/shared/world/chain';
import { waveHBase } from '@keysrun/shared/waves';
import { ampAt } from '@keysrun/shared/sim/depth-grid';
import { clamp, lerp, rand } from '../../core/math.js';
import type { ParticleSystem } from '../../world/particles.js';
import type { RemoteEngineSource } from '../../audio/interfaces.js';

type HumanRegistry = ReturnType<typeof createHumanRegistry>;

/** legacy `trafficHull` (index.html:1806-1807): every traffic hull is a `grady`-shaped hull with
 * its own length/beam/freeboard/colours. */
function trafficHull(L: number, B: number, F: number, colors: Partial<HullColors>, dr?: number): { H: HullSpec; mesh: THREE.Mesh } {
  const base = HULLS.grady;
  const H: HullSpec = { ...base, F, spring: 0.35, yk: 0.5, dr0: dr ?? 20, dr1: 48, rake: 1.2, entry: 0.42, steps: [], colors: { ...base.colors, ...colors } };
  const mesh = new THREE.Mesh(buildHullGeo(H, L, B, { deck: true } satisfies HullGeoOptions), new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.3, side: THREE.DoubleSide }));
  return { H, mesh };
}

interface TrafficPalette {
  hull: number; acc: number; top?: number; eng?: number; crew?: number; engC?: number; L?: number; board?: number; shirt?: number; pass?: number;
}

type TrafficKind = 'cc' | 'sport' | 'sail' | 'wake' | 'jetski';

/** legacy `makeTraffic` (index.html:1808-1848). */
function makeTraffic(kind: TrafficKind, pal: TrafficPalette, humans: HumanRegistry): { g: THREE.Group; L: number; B: number; surfer: THREE.Group | null } {
  const g = new THREE.Group();
  const M = (c: number): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.45 });
  const box = (w: number, h: number, d: number, c: number, x: number, y: number, z: number): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M(c));
    m.position.set(x, y, z); m.castShadow = true; g.add(m);
    return m;
  };
  const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  let L = 9, B = 3;
  let surfer: THREE.Group | null = null;

  if (kind === 'cc') {
    L = pal.L ?? 9; B = L * 0.33;
    const h = trafficHull(L, B, 1.1, { hull: pal.hull, boot: pal.acc, cove: null, bottom: 0xf2f2f0 });
    g.add(h.mesh);
    box(B * 0.42, 1.1, L * 0.13, 0xf4f4f2, 0, 0.95, 0);
    box(B * 0.7, 0.08, L * 0.27, pal.top ?? pal.hull, 0, 2.85, 0.1);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(beamBetween(V(sx * B * 0.28, 0.6, sz * L * 0.1), V(sx * B * 0.3, 2.8, sz * L * 0.12), 0.035, M(0xd9dde2)));
    const n = pal.eng ?? 2;
    for (let i = 0; i < n; i++) {
      box(0.58, 1.1, 0.7, pal.engC ?? 0xf2f2f2, (i - (n - 1) / 2) * 0.7, 0.95, L / 2 + 0.5);
      box(0.22, 1.1, 0.3, 0x2a2d31, (i - (n - 1) / 2) * 0.7, -0.1, L / 2 + 0.55);
    }
    const hp = humans.makeHuman({ shirt: pal.shirt ?? 0x9cc8e0, shorts: 0x2b3540, shortsLong: true, cap: 0x15171a, glasses: true });
    hp.group.position.set(0.3, 0.55, L * 0.13); hp.group.rotation.y = Math.PI;
    hp.pose(V(-0.15, 0.95, 0.32), V(0.15, 0.95, 0.32));
    g.add(hp.group);
    if (pal.crew) {
      const h2 = humans.makeHuman({ pose: 'seated', bikini: true, shorts: pal.crew, skin: 0xe9b48f, hair: 0xead27f, longHair: true, glasses: true });
      h2.group.position.set(0, 0.6, -L * 0.12); h2.group.rotation.y = Math.PI;
      g.add(h2.group);
    }
  } else if (kind === 'sport') {
    L = 16; B = 4.8;
    const h = trafficHull(L, B, 1.9, { hull: pal.hull, boot: 0x15171a, cove: pal.acc, bottom: 0x8a2a2a }, 16);
    g.add(h.mesh);
    box(B * 0.82, 2.1, L * 0.42, 0xf6f6f4, 0, 2.6, -L * 0.06);
    box(B * 0.84, 0.55, L * 0.4, 0x1b232b, 0, 2.9, -L * 0.06);
    box(B * 0.7, 0.9, L * 0.24, 0xf6f6f4, 0, 4.1, -L * 0.02);
    box(B * 0.8, 0.1, L * 0.28, 0xf6f6f4, 0, 5.6, -L * 0.02);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(beamBetween(V(sx * B * 0.33, 4.5, -L * 0.02 + sz * L * 0.11), V(sx * B * 0.36, 5.55, -L * 0.02 + sz * L * 0.12), 0.04, M(0xd9dde2)));
    for (const sx of [-1, 1]) g.add(beamBetween(V(sx * B * 0.4, 4.6, 0), V(sx * (B * 0.4 + 2.2), 12, L * 0.3), 0.05, M(0xd9dde2)));
    const hp = humans.makeHuman({ shirt: 0xffffff, shorts: 0x1d3557, shortsLong: true, cap: 0x1d3557, glasses: true });
    hp.group.position.set(0, 4.55, L * 0.06); hp.group.rotation.y = Math.PI;
    g.add(hp.group);
  } else if (kind === 'sail') {
    L = 11; B = 3.5;
    const h = trafficHull(L, B, 1.1, { hull: pal.hull, boot: pal.acc, cove: null, bottom: 0x1f4f8c, deck: 0xd8cdb5 }, 14);
    g.add(h.mesh);
    box(2.1, 0.7, 3.6, 0xf4f4f2, 0, 1.45, -0.3);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 15, 8), M(0xd9dde2));
    mast.position.set(0, 8.6, -1.4); g.add(mast);
    const sm = new THREE.MeshStandardMaterial({ color: 0xfbfaf6, side: THREE.DoubleSide, roughness: 0.9 });
    const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void => {
      const gg = new THREE.BufferGeometry();
      gg.setAttribute('position', new THREE.Float32BufferAttribute([...a.toArray(), ...b.toArray(), ...c.toArray()], 3));
      gg.computeVertexNormals();
      const m = new THREE.Mesh(gg, sm); m.castShadow = true; g.add(m);
    };
    tri(V(0, 2.1, -1.3), V(0, 15.6, -1.3), V(0.25, 2.1, 3.3));
    tri(V(0, 1.3, -L * 0.46), V(0, 14.5, -1.5), V(0.35, 1.6, -1.7));
  } else if (kind === 'wake') {
    L = 7.4; B = 2.6;
    const h = trafficHull(L, B, 1.2, { hull: pal.hull, boot: pal.acc, cove: pal.acc, bottom: 0x15171a, deck: 0x2a2d31 }, 14);
    g.add(h.mesh);
    box(B * 0.8, 0.35, L * 0.3, 0xf3efe6, 0, 0.95, L * 0.12);
    box(B * 0.8, 0.35, L * 0.2, 0xf3efe6, 0, 0.95, -L * 0.28);
    box(0.5, 0.9, 0.6, 0xf4f4f2, 0.55, 1.05, -L * 0.04);
    const tw2 = M(0x15171a);
    for (const sx of [-1, 1]) g.add(beamBetween(V(sx * B * 0.46, 1.05, L * 0.02), V(sx * B * 0.3, 3.1, L * 0.1), 0.05, tw2));
    box(B * 0.68, 0.12, 0.7, 0x15171a, 0, 3.12, L * 0.1);
    for (const sx of [-1, 1]) {
      const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.16, 0.3, 14), tw2);
      sp.rotation.x = Math.PI / 2; sp.position.set(sx * B * 0.28, 2.9, L * 0.1 + 0.2);
      g.add(sp);
    }
    const drv = humans.makeHuman({ shirt: 0xffffff, shorts: 0x1d3557, shortsLong: true, cap: 0x15171a, glasses: true });
    drv.group.position.set(0.55, 0.75, 0); drv.group.rotation.y = Math.PI;
    drv.pose(V(-0.15, 1.0, 0.32), V(0.15, 1.0, 0.32));
    g.add(drv.group);
    for (const [x, c] of [[-0.6, 0xe86a92], [0.6, 0x2bb3a8]] as const) {
      const p2 = humans.makeHuman({ pose: 'seated', bikini: true, shorts: c, skin: 0xe9b48f, hair: 0xead27f, longHair: true, glasses: true });
      p2.group.position.set(x, 0.65, L * 0.28); p2.group.rotation.y = Math.PI;
      g.add(p2.group);
    }
    // the surfer riding the push of the wake off the stern quarter
    const sf = new THREE.Group();
    const board = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 20), M(pal.board ?? 0xf2c14e));
    board.scale.set(0.55, 1, 1.9); sf.add(board);
    const surferH = humans.makeHuman({ walker: true, shirt: pal.shirt ?? 0x1d3557, shorts: 0x2f6fd0, shortsLong: true, hair: 0x3b2a1e, glasses: true });
    surferH.group.position.y = 0.03; surferH.group.rotation.y = Math.PI / 2;
    surferH.poseLegs(V(-0.25, 0.13, 0.05), V(0.25, 0.11, -0.05));
    surferH.pose(V(-0.5, surferH.hipY + 0.35, 0.1), V(0.55, surferH.hipY + 0.2, -0.05));
    sf.add(surferH.group);
    sf.position.set(B * 0.55, 0, L / 2 + 4.5);
    g.add(sf);
    surfer = sf;
  } else { // jetski
    L = 3.3; B = 1.2;
    const h = trafficHull(L, B, 0.55, { hull: pal.hull, boot: pal.acc, cove: pal.acc, bottom: 0x15171a, deck: 0x2a2d31 }, 18);
    g.add(h.mesh);
    box(0.45, 0.3, 1.2, 0x15171a, 0, 0.68, 0.3);
    box(0.7, 0.1, 0.12, 0x2a2d31, 0, 0.95, -0.45);
    const r = humans.makeHuman({ pose: 'seated', shirt: pal.shirt ?? 0xe4572e, shorts: 0x1d3557, shortsLong: true, glasses: true });
    r.group.position.set(0, 0.36, 0.25); r.group.rotation.y = Math.PI;
    r.pose(V(-0.25, 0.85, 0.6), V(0.25, 0.85, 0.6));
    g.add(r.group);
    if (pal.pass) {
      const p2 = humans.makeHuman({ pose: 'seated', bikini: true, shorts: pal.pass, skin: 0xe9b48f, hair: 0xead27f, longHair: true, glasses: true });
      p2.group.position.set(0, 0.4, 0.75); p2.group.rotation.y = Math.PI;
      p2.pose(V(-0.2, 0.7, 0.35), V(0.2, 0.7, 0.35));
      g.add(p2.group);
    }
  }
  g.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });
  return { g, L, B, surfer };
}

const TRAFFIC_DEF: ReadonlyArray<readonly [TrafficKind, TrafficPalette, string, number]> = [
  ['cc', { hull: 0xffffff, acc: 0x23466e, top: 0x23466e, eng: 2, crew: 0xe86a92 }, 'hawk1', 17],
  ['cc', { hull: 0xe9eef2, acc: 0x2bb3a8, top: 0xf4f4f2, eng: 3, L: 11, engC: 0x15171a }, 'hawk2', 21],
  ['sport', { hull: 0xf6f6f4, acc: 0x15171a }, 'off1', 13],
  ['sport', { hull: 0x1f2a44, acc: 0xc8a24a }, 'off2', 14],
  ['cc', { hull: 0xf2c14e, acc: 0x15171a, top: 0x15171a, eng: 2 }, 'off3', 22],
  ['sail', { hull: 0xffffff, acc: 0x1f4f8c }, 'hawk3', 4],
  ['sail', { hull: 0xf6f1e4, acc: 0xc8302e }, 'west', 3.5],
  ['jetski', { hull: 0xffffff, acc: 0xe4572e, shirt: 0x2bb3a8 }, 'harbor', 14],
  ['jetski', { hull: 0x15171a, acc: 0x7fe3d4, shirt: 0xe86a92 }, 'bayE', 16],
  ['cc', { hull: 0xffffff, acc: 0x15171a, top: 0xffffff, eng: 4, L: 12, crew: 0x2f6fd0 }, 'bayE', 20],
  ['cc', { hull: 0xa7e6da, acc: 0x0f6e7a, top: 0xf4f4f2, eng: 1, L: 7 }, 'bay', 14],
  ['cc', { hull: 0xffffff, acc: 0xc8102e, top: 0xc8102e, eng: 2, crew: 0xf2c14e }, 'reef', 18],
  ['wake', { hull: 0xffffff, acc: 0x15171a, board: 0xf2c14e, shirt: 0xe4572e }, 'bayN', 5.5],
  ['wake', { hull: 0x1f2a44, acc: 0xe4572e, board: 0x7fe3d4, shirt: 0x2bb3a8 }, 'bayE', 5.5],
  ['wake', { hull: 0xf2f2f2, acc: 0x2bb3a8, board: 0xe86a92, shirt: 0xffffff }, 'west', 5.3],
  ['jetski', { hull: 0xf2c14e, acc: 0x15171a, shirt: 0x1d3557, pass: 0xe86a92 }, 'harbor', 12],
  ['jetski', { hull: 0x2f6fd0, acc: 0xffffff, shirt: 0xf2f2f2 }, 'hawk1', 18],
  ['jetski', { hull: 0xe4572e, acc: 0xffffff, shirt: 0x2b3540, pass: 0x2bb3a8 }, 'hawk3', 16],
  ['jetski', { hull: 0x7fe3d4, acc: 0x15171a, shirt: 0xe4572e }, 'beach', 17],
  ['jetski', { hull: 0xffffff, acc: 0xb05bff, shirt: 0x9cc8e0, pass: 0xf2c14e }, 'beach', 15],
  ['jetski', { hull: 0xc8102e, acc: 0xffffff, shirt: 0x15171a }, 'west', 13],
  ['jetski', { hull: 0x15171a, acc: 0xf2c14e, shirt: 0xffffff }, 'sombrero', 16],
  ['jetski', { hull: 0x9fd8ff, acc: 0x1f4f8c, shirt: 0xe86a92, pass: 0xe4572e }, 'sombrero', 14],
];

const LOCAL_ROUTES = new Set(['harbor', 'west', 'bayE', 'bay', 'beach', 'sombrero', 'bayN']);

const ROUTES: Record<string, () => Path> = {
  hawk1: () => chainRoute(450, 1000), hawk2: () => chainRoute(620, 1150), hawk3: () => chainRoute(800, 950),
  off1: () => chainRoute(1900, 2700), off2: () => chainRoute(2300, 3200), off3: () => chainRoute(1750, 2150),
  reef: () => chainRoute(1200, 1320), bay: () => chainRoute(-700, -1150),
  harbor: () => pointRoute([[-1560, chainZ(-1560) + 300], [-1100, chainZ(-1100) + 315], [-680, chainZ(-680) + 305], [-1100, chainZ(-1100) + 295]]),
  west: () => pointRoute([[1800, -2660], [2110, -2660], [2110, -2200], [1880, -2300]]),
  bayE: () => pointRoute([[3080, -2660], [3600, -2660], [3600, -1960], [3080, -1960]]),
  bayN: () => pointRoute([[-900, chainZ(-900) - 520], [200, chainZ(200) - 560], [900, chainZ(900) - 520], [200, chainZ(200) - 700], [-900, chainZ(-900) - 680]]),
  beach: () => pointRoute([[2500, -1480], [3200, -1470], [4000, -1480], [4000, -1420], [3200, -1410], [2500, -1420]]),
  sombrero: () => pointRoute([[-150, chainZ(-150) + 330], [700, chainZ(700) + 340], [1100, chainZ(1100) + 300], [700, chainZ(700) + 400], [-150, chainZ(-150) + 420]]),
};

interface TrafficBoat {
  kind: TrafficKind;
  g: THREE.Group;
  L: number; B: number;
  R: Path;
  s: number;
  speed: number;
  off: number; offT: number;
  h: number;
  relT: number;
  wake: number;
  wt: number;
  local: boolean;
  surfer: THREE.Group | null;
  ph: number;
  hopT: number;
  hop: number;
  hitT: number;
}

export interface TrafficFleet {
  update(dt: number, t: number, boat: { x: number; z: number }, camera: { x: number; z: number }, particles: ParticleSystem): void;
  /** Push-out for the player's hull against anything it's overlapping, plus a bump toast — legacy
   * mutated the global `boat` object directly mid-loop; returns the correction instead since
   * this module doesn't own boat state. `{dx,dz}` is a position nudge, `speedMul` the drag hit. */
  resolvePlayerCollisions(boat: { x: number; z: number; len: number }, t: number): { dx: number; dz: number; speedMul: number; bumped: boolean };
  engineSources(): RemoteEngineSource[];
  /** Raw snapshot for `stubs.ts`'s `installWorldLife` — see that module's header. */
  listTraffic(): readonly TrafficBoat[];
}

/** legacy `TRAFFIC` (index.html:1915-1917): 23 boats, one per `TRAFFIC_DEF` entry. */
export function createTrafficFleet(scene: THREE.Scene): TrafficFleet {
  const humans = createHumanRegistry();
  const traffic: TrafficBoat[] = TRAFFIC_DEF.map(([kind, pal, rt, spd], i) => {
    const R = ROUTES[rt]();
    const m = makeTraffic(kind, pal, humans);
    scene.add(m.g);
    return {
      kind, g: m.g, L: m.L, B: m.B, R, s: Math.random() * R.total, speed: spd * rand(0.9, 1.1),
      off: 0, offT: 0, h: 0, relT: i * 0.2, wake: 0, wt: 0, local: LOCAL_ROUTES.has(rt),
      surfer: m.surfer, ph: Math.random() * 20, hopT: rand(2, 6), hop: 0, hitT: -9,
    };
  });

  return {
    update(dt, t, boat, camera, particles) {
      humans.updateHumans(t, { x: camera.x, y: 0, z: camera.z }, 0);
      for (const r of traffic) {
        r.relT -= dt;
        if (r.relT <= 0) {
          r.relT = 1.3;
          if (!r.local && Math.hypot(r.g.position.x - boat.x, r.g.position.z - boat.z) > 1100) r.s = r.R.closestS(boat.x, boat.z) - rand(450, 800) * (Math.random() < 0.5 ? 1 : -1);
        }
        r.s += r.speed * dt;
        const P = r.R.at(r.s), px = -P.tz, pz = P.tx;
        const rx = boat.x - P.x, rz = boat.z - P.z, along = rx * P.tx + rz * P.tz, side = rx * px + rz * pz;
        if (along > -20 && along < 150 && Math.abs(side - r.off) < 20) r.offT = side > 0 ? side - 28 : side + 28;
        r.offT *= 1 - dt * 0.15;
        r.off = lerp(r.off, clamp(r.offT, -45, 45), Math.min(1, dt * 0.8));
        const weave = r.kind === 'jetski' ? Math.sin(t * 0.9 + r.ph) * 14 + Math.sin(t * 2.3 + r.ph * 1.7) * 4 : 0;
        const x = P.x + px * (r.off + weave), z = P.z + pz * (r.off + weave);
        const wv = r.kind === 'jetski' ? Math.atan(Math.cos(t * 0.9 + r.ph) * 14 * 0.9 / Math.max(4, r.speed)) : 0;
        r.h = angLerp(r.h, Math.atan2(-P.tx, -P.tz) - wv, dt * (r.kind === 'jetski' ? 4 : 1.8));
        const fx = -Math.sin(r.h), fz = -Math.cos(r.h), amp = ampAt(x, z), hl = r.L * 0.45;
        const hb = waveHBase(x + fx * hl, z + fz * hl, t, amp), hs = waveHBase(x - fx * hl, z - fz * hl, t, amp);
        const rxv = Math.cos(r.h), rzv = -Math.sin(r.h);
        const hp = waveHBase(x - rxv * r.B * 0.5, z - rzv * r.B * 0.5, t, amp), hst = waveHBase(x + rxv * r.B * 0.5, z + rzv * r.B * 0.5, t, amp);
        const fr = r.kind === 'sail' ? 0 : Math.min(1, r.speed / 20);
        let hopY = 0, hopP = 0;
        if (r.kind === 'jetski') {
          r.hopT -= dt;
          if (r.hopT <= 0 && !r.hop) r.hop = 0.75;
          if (r.hop > 0) {
            r.hop -= dt;
            const p = 1 - r.hop / 0.75;
            hopY = Math.sin(p * Math.PI) * 1.3; hopP = Math.cos(p * Math.PI) * 0.35;
            if (r.hop <= 0) { r.hop = 0; r.hopT = rand(2.5, 7); particles.splash(x, z, 10, 0.8); }
          }
        }
        r.g.position.set(x, (hb + hs) / 2 + fr * 0.25 + hopY, z);
        r.g.rotation.set(Math.atan2(hb - hs, r.L) + fr * 0.06 + hopP, r.h, Math.atan2(hp - hst, r.B) * 0.7 + (r.kind === 'sail' ? 0.16 : 0) + (r.kind === 'jetski' ? -wv * 1.4 : 0), 'YXZ');
        const dCam = Math.hypot(x - camera.x, z - camera.z);
        r.g.visible = dCam < 1700;
        r.wt += dt;
        if (r.wt > 0.4 && r.speed > 3 && Math.hypot(x - boat.x, z - boat.z) < 800) r.wt = 0; // (legacy's shared-pool emitWake dropped; see module header)
        if (r.surfer) {
          const sfg = r.surfer, ph = t * 0.7 + r.ph;
          sfg.position.x = r.B * 0.55 + Math.sin(ph) * 1.3;
          sfg.position.y = 0.05 + Math.max(0, Math.cos(ph * 2)) * 0.12;
          sfg.rotation.set(0, Math.sin(ph) * 0.35, -Math.cos(ph) * 0.28);
          if (dCam < 350 && Math.random() < 0.8) {
            const lx = x + rxv * (r.B * 0.7) - fx * (r.L * 0.5 + 1), lz = z + rzv * (r.B * 0.7) - fz * (r.L * 0.5 + 1);
            for (let k = 0; k < 2; k++) {
              const u = Math.random() * 5;
              particles.spawnP(lx - fx * u + rxv * rand(0, 1.5), 0.2, lz - fz * u + rzv * rand(0, 1.5), rxv * rand(0.5, 1.5), rand(0.5, 1.6), rzv * rand(0.5, 1.5), rand(0.4, 0.8), rand(0.5, 1), 0.7, true);
            }
          }
        }
        if (dCam < 500 && r.speed > 3) {
          r.wake += dt * (r.kind === 'jetski' ? 14 : 9);
          const sx = x - fx * r.L * 0.52, sz = z - fz * r.L * 0.52;
          while (r.wake > 1) {
            r.wake--;
            for (const sg of [-1, 1]) particles.spawnP(sx + rxv * r.B * 0.4 * sg, 0.1, sz + rzv * r.B * 0.4 * sg, rxv * sg * 2 - fx * 2, 0, rzv * sg * 2 - fz * 2, rand(2, 3.5), rand(1, 1.8), 0.5, false, amp);
            if (r.kind === 'jetski') particles.spawnP(sx, 0.3, sz, -fx * rand(3, 6), rand(3, 6), -fz * rand(3, 6), rand(0.5, 0.9), rand(0.5, 0.9), 0.8, true);
          }
        }
      }
    },
    resolvePlayerCollisions(boat, t) {
      let dx = 0, dz = 0, speedMul = 1, bumped = false;
      for (const r of traffic) {
        const ddx = boat.x + dx - r.g.position.x, ddz = boat.z + dz - r.g.position.z, dd = Math.hypot(ddx, ddz), rr = (r.L + boat.len) * 0.42;
        if (dd < rr && dd > 0.01) {
          dx += ddx / dd * (rr - dd); dz += ddz / dd * (rr - dd);
          speedMul = Math.min(speedMul, 0.6);
          if (t - r.hitT > 3) { r.hitT = t; bumped = true; }
        }
      }
      return { dx, dz, speedMul, bumped };
    },
    engineSources(): RemoteEngineSource[] {
      return traffic.map((r, i): RemoteEngineSource => ({
        id: `traffic${i}`, x: r.g.position.x, z: r.g.position.z, speed: r.speed,
        engineProfile: 'grady', engineCount: r.kind === 'sport' ? 4 : r.kind === 'cc' ? 2 : 1,
        audible: r.g.visible && r.kind !== 'sail',
      }));
    },
    listTraffic(): readonly TrafficBoat[] { return traffic; },
  };
}
