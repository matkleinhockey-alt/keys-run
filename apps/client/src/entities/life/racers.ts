/**
 * Go-fast boats cruising the chain at speed, three in rotation, each with a driver and four
 * bikini-clad passengers (two seated up front, three lounging aft).
 *
 * Ported faithfully from legacy/index.html:1740-1803 (`makeRoute`→`entities/life/path.ts`'s
 * `chainRoute`, `routeAt`→`Path.at`, `closestS`→`Path.closestS`, `makeRacer`, `RACER_PAL`,
 * `RACERS`, `updateRacers`).
 *
 * Wake: legacy fed each racer's wake into the *shared* global `wakeP` pool that also drove the
 * water shader's visual ripple (`emitWake`). That pool is now `BoatState.wakeRing`, restructured
 * to be the player's own boat only (packages/shared/src/sim/boat.ts, docs/ARCHITECTURE.md's
 * "KNOWN LANDMINE" on `waveH`/`wakeH`) — `world/water.ts`'s single `uWakeP` uniform has no slots
 * reserved for anyone else. Racers therefore don't ripple the water surface; they still throw a
 * full particle wake/spray trail (the dominant visual anyway) and bob on the plain wave sum.
 */
import * as THREE from 'three';
import { chainRoute, angLerp, type Path } from './path.js';
import { createHumanRegistry } from './human.js';
import { buildHullGeo, hullStation } from '../boat/hull.js';
import type { HullSpec } from '@keysrun/shared/content/boats';
import { waveHBase } from '@keysrun/shared/waves';
import { ampAt } from '@keysrun/shared/sim/depth-grid';
import { clamp, lerp, rand } from '../../core/math.js';
import type { ParticleSystem } from '../../world/particles.js';
import type { RemoteEngineSource } from '../../audio/interfaces.js';

interface RacerPalette { h: number; b: number; c: number; u: number; s: readonly number[] }

const RACER_PAL: readonly RacerPalette[] = [
  { h: 0xffffff, b: 0xe4572e, c: 0xf2c14e, u: 0xf3efe6, s: [0xe4572e, 0x2bb3a8, 0xe86a92, 0xf2c14e, 0x2f6fd0] },
  { h: 0x15171a, b: 0x2bd4c4, c: 0xe86a92, u: 0x15171a, s: [0xe86a92, 0xffffff, 0x2bd4c4, 0xf2c14e, 0xe4572e] },
  { h: 0xf2c14e, b: 0x15171a, c: 0xe4572e, u: 0x15171a, s: [0x15171a, 0xe4572e, 0x2f6fd0, 0xffffff, 0xe86a92] },
];

/** legacy `makeRacer` (index.html:1752-1775). `H.style` is filled with plausible values purely
 * to satisfy `HullSpec`'s type — `buildHullGeo`/`hullStation` (the only things this function
 * calls `H` into) never read it; legacy's racer hull object only ever set the 7 fields that
 * matter (`F,spring,yk,dr0,dr1,rake,entry,steps,colors`). */
function makeRacer(pal: RacerPalette, humans: ReturnType<typeof createHumanRegistry>): THREE.Group {
  const L = 12.8, B = 2.6;
  const H: HullSpec = {
    F: 0.95, spring: 0.12, yk: 0.55, dr0: 24, dr1: 52, rake: 3.4, entry: 0.52, steps: [0.27, 0.4],
    colors: { bottom: 0x15171a, boot: pal.b, hull: pal.h, cove: pal.c, rub: 0x111111, cap: pal.h, liner: 0xf2f2f2, deck: 0x2a2d31 },
    style: { top: 'none', frame: pal.h, topc: pal.h, seat: 'leaning', bowRail: false, outriggers: false, mount: 'bracket', uph: pal.u, eng: pal.h, engAcc: pal.h, engLow: pal.h },
  };
  const g = new THREE.Group();
  g.add(new THREE.Mesh(buildHullGeo(H, L, B, { deck: true }), new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.25, metalness: 0.1, side: THREE.DoubleSide })));
  const M = (c: number, o?: Partial<THREE.MeshStandardMaterialParameters>) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.45, ...o });
  const box = (w: number, h: number, d: number, c: number, x: number, y: number, z: number): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), M(c));
    m.position.set(x, y, z); m.castShadow = true; g.add(m);
    return m;
  };
  const sstep = (a: number, b: number, x: number): number => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const st = (z: number) => hullStation(H, L, B, clamp((L / 2 - z) / (L - H.rake * 0.5), 0, 1));
  const D = 0.55 + L * 0.012;
  const sole = (z: number): number => { const s = st(z); return s.ys - D * (1 - 0.4 * sstep(0.55, 0.85, s.t)); };

  box(B * 0.82, 0.2, L * 0.24, pal.h, 0, H.F + 0.06, L * 0.33);
  for (let i = 0; i < 3; i++) box(B * 0.5, 0.04, 0.12, 0x15171a, 0, H.F + 0.17, L * 0.26 + i * 0.4);
  const s1 = sole(L * 0.05), s2 = sole(L * 0.16);
  box(B * 0.72, 0.42, 0.55, pal.u, 0, s1 + 0.21, L * 0.05);
  box(B * 0.72, 0.42, 0.55, pal.u, 0, s2 + 0.21, L * 0.16);
  const bk1 = box(B * 0.72, 0.55, 0.12, pal.u, 0, s1 + 0.65, L * 0.05 + 0.3); bk1.rotation.x = 0.15;
  const bk2 = box(B * 0.72, 0.55, 0.12, pal.u, 0, s2 + 0.65, L * 0.16 + 0.3); bk2.rotation.x = 0.15;
  const ws = new THREE.Mesh(new THREE.BoxGeometry(B * 0.8, 0.5, 0.03), new THREE.MeshStandardMaterial({ color: 0x6f97a8, transparent: true, opacity: 0.4 }));
  ws.position.set(0, H.F + 0.25, -L * 0.06); ws.rotation.x = -0.5; g.add(ws);
  box(B * 0.6, 0.25, 0.5, 0x15171a, 0, H.F - 0.05, -L * 0.04);
  const cz = -L * 0.22, cy = st(cz).ys;
  box(B * 0.78, 0.06, L * 0.2, pal.h, 0, cy + 0.02, cz);
  box(B * 0.66, 0.12, L * 0.18, pal.u, 0, cy + 0.11, cz);
  for (const sx of [-1, 1]) {
    box(0.18, 0.7, 0.32, 0x15171a, sx * 0.45, -0.15, L / 2 + 0.25);
    box(0.32, 0.03, 0.35, 0x15171a, sx * 0.45, -0.4, L / 2 + 0.28);
  }

  const blonde = (c: number) => ({ bikini: true, shorts: c, skin: 0xe9b48f, hair: 0xead27f, longHair: true, glasses: true });
  const drv = humans.makeHuman({ shirt: 0xffffff, shorts: 0x1d3557, shortsLong: true, hair: 0x2b1d14, cap: 0x15171a, shoes: 0xf2f2f2, glasses: true });
  drv.group.position.set(-0.45, sole(-L * 0.01), -L * 0.01);
  drv.group.rotation.y = Math.PI;
  drv.pose(new THREE.Vector3(-0.15, 1.05, 0.4), new THREE.Vector3(0.12, 1.05, 0.42));
  g.add(drv.group);
  ([-0.42, 0.42] as const).forEach((x, i) => {
    const h = humans.makeHuman({ pose: 'seated', ...blonde(pal.s[i]) });
    h.group.position.set(x, s1 + 0.42 - h.hipY, L * 0.05 - 0.05);
    h.group.rotation.y = Math.PI;
    g.add(h.group);
  });
  ([-0.55, 0, 0.55] as const).forEach((x, i) => {
    const h = humans.makeHuman({ pose: 'lounge', ...blonde(pal.s[(i + 2) % pal.s.length]) });
    h.group.position.set(x, cy + 0.17 + 0.05 - h.hipY, cz + L * 0.08);
    h.group.rotation.y = Math.PI;
    g.add(h.group);
  });
  g.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });
  return g;
}

export interface Racer {
  g: THREE.Group;
  R: Path;
  s: number;
  speed: number;
  off: number;
  offT: number;
  h: number;
  relT: number;
  wake: number;
  wt: number;
}

export interface RacerFleet {
  update(dt: number, t: number, boat: { x: number; z: number }, camera: { x: number; z: number }, particles: ParticleSystem): void;
  /** For `audio/engine.ts`'s `AudioFrameInputs.racers` — each racer's go-fast V8 doppler pass. */
  engineSources(): RemoteEngineSource[];
  /** Raw snapshot for `stubs.ts`'s `installWorldLife` — see that module's header. */
  listRacers(): readonly Racer[];
}

/** legacy `RACERS` (index.html:1781-1782): 3 racers, each on its own route (built from a
 * `chainRoute(dzOut, dzBack)` sweep) and palette. */
export function createRacerFleet(scene: THREE.Scene): RacerFleet {
  const humans = createHumanRegistry();
  const ROUTES: ReadonlyArray<readonly [number, number]> = [[880, 1250], [1850, 2600], [700, 1700]];
  const racers: Racer[] = ROUTES.map(([a, b], i) => {
    const R = chainRoute(a, b);
    const g = makeRacer(RACER_PAL[i], humans);
    scene.add(g);
    return { g, R, s: Math.random() * R.total, speed: rand(30, 36), off: 0, offT: 0, h: 0, relT: i * 0.3, wake: 0, wt: 0 };
  });

  return {
    update(dt, t, boat, camera, particles) {
      humans.updateHumans(t, { x: camera.x, y: 0, z: camera.z }, 0);
      for (const r of racers) {
        r.relT -= dt;
        if (r.relT <= 0) { r.relT = 1; if (Math.hypot(r.g.position.x - boat.x, r.g.position.z - boat.z) > 900) r.s = r.R.closestS(boat.x, boat.z) - rand(420, 650); }
        r.s += r.speed * dt;
        const P = r.R.at(r.s), px = -P.tz, pz = P.tx;
        const rx = boat.x - P.x, rz = boat.z - P.z, along = rx * P.tx + rz * P.tz, side = rx * px + rz * pz;
        if (along > -25 && along < 180 && Math.abs(side - r.off) < 26) r.offT = side > 0 ? side - 38 : side + 38;
        r.offT *= 1 - dt * 0.15;
        r.off = lerp(r.off, clamp(r.offT, -55, 55), Math.min(1, dt * 0.9));
        const x = P.x + px * r.off, z = P.z + pz * r.off;
        r.h = angLerp(r.h, Math.atan2(-P.tx, -P.tz), dt * 3);
        const fx = -Math.sin(r.h), fz = -Math.cos(r.h), amp = ampAt(x, z) * 0.8;
        const hb = waveHBase(x + fx * 6, z + fz * 6, t, amp), hs = waveHBase(x - fx * 6, z - fz * 6, t, amp);
        r.g.position.set(x, (hb + hs) / 2 + 0.32, z);
        r.g.rotation.set(Math.atan2(hb - hs, 12.8) + 0.07, r.h, Math.sin(t * 1.3 + r.s * 0.01) * 0.03, 'YXZ');
        r.wt += dt;
        if (r.wt > 0.35 && Math.hypot(x - boat.x, z - boat.z) < 800) r.wt = 0; // (legacy's shared-pool emitWake dropped; see module header)
        const dCam = Math.hypot(x - camera.x, z - camera.z);
        r.g.visible = dCam < 1700;
        const near = dCam < 700;
        if (near) {
          r.wake += dt * 20;
          const rxv = Math.cos(r.h), rzv = -Math.sin(r.h), sx = x - fx * 7, sz = z - fz * 7;
          while (r.wake > 1) {
            r.wake--;
            for (const sg of [-1, 1]) particles.spawnP(sx + rxv * 1.1 * sg, 0.1, sz + rzv * 1.1 * sg, rxv * sg * 3 - fx * 4, 0, rzv * sg * 3 - fz * 4, rand(2.5, 4), rand(1.4, 2.2), 0.55, false, amp);
            particles.spawnP(sx, 0.3, sz, -fx * rand(4, 8) + rand(-1, 1), rand(4, 7), -fz * rand(4, 8) + rand(-1, 1), rand(0.6, 1), rand(0.6, 1.1), 0.8, true);
          }
        }
      }
    },
    engineSources(): RemoteEngineSource[] {
      return racers.map((r, i): RemoteEngineSource => ({ id: `racer${i}`, x: r.g.position.x, z: r.g.position.z, speed: r.speed, engineProfile: 'gofast', engineCount: 1, audible: r.g.visible }));
    },
    listRacers(): readonly Racer[] { return racers; },
  };
}
