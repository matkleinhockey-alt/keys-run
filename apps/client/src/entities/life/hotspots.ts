/**
 * Hotspots (birds working bait, with feeding frenzies that come and go), floating sargassum
 * weedlines, and offshore oil platforms — the three "follow the birds to find a bite" landmarks.
 *
 * Ported faithfully from legacy/index.html:1977-2034 (seabirds → `seabirds.ts`), 2036-2077
 * (`hotspots`/`HS_COUNTS`/`spawnHotspot`/`updateHotspots`), 2078-2090 (`WEEDS`), 2091-2133
 * (`RIGS`/`updateRigs`/`nearRig`), 2134-2143 (`nearWeed`/`updateWeeds`).
 *
 * **Determinism** (docs/ARCHITECTURE.md "Seeding"): hotspot and weedline placement is gameplay-
 * relevant world content — every player must see the same bird-and-bait spot — so it's derived
 * from `hashCell(WORLD_SEED, cell, attempt, salt)` instead of legacy's `Math.random()` rejection
 * sampling (which was also order-dependent: adding hotspot #41 would have reshuffled every one
 * after it). Rig placement needed no such treatment — legacy's 4 rig sites are already fixed
 * coordinates, not randomised at all. Per-blade jitter inside a weed patch, and the exact instant
 * a frenzy flares up, stay `Math.random()` — purely cosmetic, not world content.
 *
 * Fish anchoring (legacy `ensureAnchors`) is explicitly **not** ported — it reaches into
 * `entities/fish/**`'s `groups`/`spawnGroupAt`/`VIS`, which this task does not own. `fish` counts
 * are kept on each site as inert flavour data for whoever wires that up later.
 */
import * as THREE from 'three';
import { makeSeabird, poseBird, moveBird, type Bird } from './seabirds.js';
import { beamBetween } from '../boat/hull.js';
import { glowTex } from '../boat/decor-textures.js';
import type { LightMatEntry } from '../../core/time-of-day.js';
import { WB, HUMPS, CREEKS, depthAt, zoneAt, type Zone } from '@keysrun/shared/world/depth';
import { chainZ, shoreInfo } from '@keysrun/shared/world/chain';
import { ampFor, waveHBase } from '@keysrun/shared/waves';
import { hashCell } from '@keysrun/shared/rng';
import { WORLD_SEED, SALT } from '../../state/constants.js';
import { lerp, rand } from '../../core/math.js';
import { toast } from '../../ui/toast.js';
import type { ParticleSystem } from '../../world/particles.js';

const HS_COUNTS: Record<Zone, number> = { Creek: 3, Flats: 7, Backcountry: 6, Bridge: 4, 'Hawk Channel': 5, Reef: 6, Offshore: 9 };
const ZONE_CODE: Record<Zone, number> = { Creek: 0, Flats: 1, Backcountry: 2, Bridge: 3, 'Hawk Channel': 4, Reef: 5, Offshore: 6 };

export interface GullSite { x: number; z: number }

export interface Hotspot extends GullSite {
  zone: Zone;
  g: THREE.Group;
  birds: Array<{ B: Bird; r: number; h: number; sp: number; ph: number; dive: Record<string, number> | null }>;
  weeds: THREE.Mesh[];
  fish: number;
  amp: number;
  fT: number;
  active: boolean;
  fr: number;
  told: boolean;
}

/** legacy `spawnHotspot`'s placement half (index.html:2040-2043), restructured per this module's
 * header into a deterministic, position/index-derived pick instead of rejection-sampling against
 * the live boat position. */
function placeHotspot(zone: Zone, i: number): { x: number; z: number } | null {
  const cell = ZONE_CODE[zone] * 1000 + i;
  if (zone === 'Creek' && CREEKS.length) {
    const ci = Math.min(CREEKS.length - 1, Math.floor(hashCell(WORLD_SEED, cell, 0, SALT.HOTSPOT_CREEK_PICK) * CREEKS.length));
    const C = CREEKS[ci];
    const frac = lerp(0.2, 0.8, hashCell(WORLD_SEED, cell, 0, SALT.HOTSPOT_CREEK_FRAC));
    const q = C.pts[Math.min(C.pts.length - 1, Math.floor(frac * C.pts.length))];
    return { x: q[0], z: q[1] };
  }
  if (zone === 'Offshore' && hashCell(WORLD_SEED, cell, 0, SALT.HOTSPOT_HUMP_PICK) < 0.45) {
    const H = HUMPS[hashCell(WORLD_SEED, cell, 1, SALT.HOTSPOT_HUMP_PICK) < 0.55 ? 0 : 1];
    const x = H.x + lerp(-260, 260, hashCell(WORLD_SEED, cell, 0, SALT.HOTSPOT_X));
    const z = chainZ(H.x) + H.dz + lerp(-260, 260, hashCell(WORLD_SEED, cell, 0, SALT.HOTSPOT_Z));
    return { x, z };
  }
  for (let k = 0; k < 300; k++) {
    const x = lerp(WB.x0 + 100, WB.x1 - 100, hashCell(WORLD_SEED, cell, k, SALT.HOTSPOT_X));
    const z = lerp(WB.z0 + 100, WB.z1 - 100, hashCell(WORLD_SEED, cell, k, SALT.HOTSPOT_Z));
    if (zoneAt(x, z) === zone && shoreInfo(x, z).d > 10) return { x, z };
  }
  return null;
}

const weedMat = new THREE.MeshStandardMaterial({ color: 0xc69a33, flatShading: true, roughness: 1 });

/** legacy `spawnHotspot` (index.html:2039-2051). */
function spawnHotspot(scene: THREE.Scene, zone: Zone, i: number): Hotspot | null {
  const p = placeHotspot(zone, i);
  if (!p) return null;
  const { x, z } = p;
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const birds: Hotspot['birds'] = [];
  for (let k = 0; k < 11; k++) {
    const B = makeSeabird(k % 4 === 3 ? 'tern' : 'gull', 1.25);
    g.add(B.g);
    birds.push({ B, r: rand(6, 13), h: rand(10, 18), sp: rand(0.5, 0.9) * (Math.random() < 0.5 ? -1 : 1), ph: Math.random() * 6.28, dive: null });
  }
  const weeds: THREE.Mesh[] = [];
  if (zone === 'Offshore') {
    const ang = Math.random() * Math.PI;
    for (let k = 0; k < 14; k++) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(rand(4, 8), 0.12, rand(1, 2)), weedMat);
      const t = (k - 7) * 5.5;
      w.position.set(Math.cos(ang) * t + rand(-1.5, 1.5), 0, Math.sin(ang) * t + rand(-1.5, 1.5));
      w.rotation.y = -ang + rand(-0.3, 0.3);
      g.add(w);
      weeds.push(w);
    }
  }
  scene.add(g);
  return { zone, x, z, g, birds, weeds, fish: 2 + Math.floor(Math.random() * 3), amp: ampFor(depthAt(x, z)), fT: rand(3, 20), active: false, fr: 0, told: false };
}

export interface WeedPatch extends GullSite {
  ang: number; len: number; wid: number;
  im: THREE.InstancedMesh;
  off: Array<[number, number, number, number]>;
  bg: THREE.Group;
  birds: Array<{ B: Bird; r: number; h: number; sp: number; ph: number }>;
  amp: number;
  told: boolean;
}

function spawnWeedPatches(scene: THREE.Scene): WeedPatch[] {
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1 });
  const WC = [0xc69a33, 0xb4862a, 0xd8b04a, 0x9c7424, 0xe0bf5a, 0xa98a3a];
  const col = new THREE.Color();
  const spots: Array<[number, number]> = [];
  for (let k = 0; k < 400 && spots.length < 18; k++) {
    const x = lerp(-3800, 3800, hashCell(WORLD_SEED, k, 0, SALT.WEED_X));
    const z = chainZ(x) + lerp(1550, 3700, hashCell(WORLD_SEED, k, 0, SALT.WEED_Z));
    if (depthAt(x, z) > 35) spots.push([x, z]);
  }
  HUMPS.filter((H) => !H.patch).forEach((H, hi) => {
    for (let k = 0; k < 2; k++) {
      spots.push([
        H.x + lerp(-300, 300, hashCell(WORLD_SEED, hi * 2 + k, 0, SALT.WEED_HUMP_OFFX)),
        chainZ(H.x) + H.dz + lerp(-300, 300, hashCell(WORLD_SEED, hi * 2 + k, 0, SALT.WEED_HUMP_OFFZ)),
      ]);
    }
  });
  return spots.map(([x, z], si) => {
    const len = lerp(50, 170, hashCell(WORLD_SEED, si, 0, SALT.WEED_LEN));
    const wid = lerp(3, 9, hashCell(WORLD_SEED, si, 0, SALT.WEED_WID));
    const ang = hashCell(WORLD_SEED, si, 0, SALT.WEED_ANG) * Math.PI;
    const n = Math.round(len / 2.2);
    const im = new THREE.InstancedMesh(geo, mat, n);
    const off: Array<[number, number, number, number]> = [];
    for (let i = 0; i < n; i++) {
      // Per-blade placement within an already-deterministic patch — pure visual jitter, stays Math.random().
      const u = (i / n - 0.5) * len, v = (Math.random() - 0.5) * wid * (1 - Math.abs(u / len) * 1.2), s = rand(0.7, 2.2);
      off.push([Math.cos(ang) * u - Math.sin(ang) * v, Math.sin(ang) * u + Math.cos(ang) * v, s, Math.random() * 6]);
      im.setColorAt(i, col.setHex(WC[i % WC.length]));
    }
    im.frustumCulled = false;
    scene.add(im);
    const birds: WeedPatch['birds'] = [];
    const bg = new THREE.Group();
    scene.add(bg);
    for (let i = 0; i < 3; i++) {
      const B = makeSeabird(i === 2 ? 'gull' : 'frigate', 1.2);
      bg.add(B.g);
      birds.push({ B, r: rand(15, 30), h: rand(18, 30), sp: rand(0.3, 0.5) * (Math.random() < 0.5 ? -1 : 1), ph: Math.random() * 6 });
    }
    return { x, z, ang, len, wid, im, off, bg, birds, amp: ampFor(depthAt(x, z)), told: false };
  });
}

export interface Rig extends GullSite {
  /** `undefined` on a `twin` marker (legacy `RIGS.push({...,twin:true})`, index.html:2128) — a
   * second fishable point near the platform with no geometry of its own; never visible and never
   * matched by `nearRig` (legacy's own `R.g&&...`), kept only as inert anchor data for whoever
   * wires fish-group anchoring (`ensureAnchors`) up later — see this module's header. */
  g?: THREE.Group;
  fl?: THREE.Mesh;
  fish: number;
  twin: boolean;
  told: boolean;
}

/** legacy `RIGS` (index.html:2091-2129): 4 fixed offshore platforms — no randomness at all, so
 * no `hashCell` treatment is needed (see this module's header). */
function spawnRigs(scene: THREE.Scene, lightMats: LightMatEntry[]): Rig[] {
  const spots: ReadonlyArray<readonly [number, number]> = [[-3250, 2950], [-900, 3150], [1550, 2800], [3350, 3100]];
  const steel = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.55, metalness: 0.4 });
  const rust = new THREE.MeshStandardMaterial({ color: 0x7a4a2a, roughness: 0.8, metalness: 0.2 });
  const deckM = new THREE.MeshStandardMaterial({ color: 0x6b7178, roughness: 0.7, metalness: 0.3 });
  const whiteM = new THREE.MeshStandardMaterial({ color: 0xeef0f1, roughness: 0.6 });
  const orangeM = new THREE.MeshStandardMaterial({ color: 0xe4572e, roughness: 0.6 });
  const heliM = new THREE.MeshStandardMaterial({ color: 0x2f6e4a, roughness: 0.7 });
  const flameM = new THREE.MeshBasicMaterial({ map: glowTex(), color: 0xff8a2a, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const lampM = new THREE.SpriteMaterial({ map: glowTex(), color: 0xffe6a8, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.2 });
  lightMats.push({ m: lampM, day: 0.15, night: 1 });
  const V = (a: number, b: number, c: number): THREE.Vector3 => new THREE.Vector3(a, b, c);
  const beam = (g: THREE.Group, a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material): void => { g.add(beamBetween(a, b, r, m)); };

  const rigs: Rig[] = [];
  spots.forEach(([x, dz], ri) => {
    const z = chainZ(x) + dz;
    if (depthAt(x, z) < 20) return;
    const g = new THREE.Group();
    g.position.set(x, 0, z); g.rotation.y = ri * 0.6;
    scene.add(g);
    const H = 12, base = -Math.min(40, depthAt(x, z)), top = 18;
    const legs: ReadonlyArray<readonly [number, number]> = [[-H, -H], [H, -H], [H, H], [-H, H]];
    legs.forEach(([lx, lz]) => {
      beam(g, V(lx * 1.25, base, lz * 1.25), V(lx * 1.04, -0.6, lz * 1.04), 0.95, rust);
      beam(g, V(lx * 1.04, -0.6, lz * 1.04), V(lx, top, lz), 0.9, steel);
    });
    for (const y of [-16, -6, 6, 13]) {
      const k = y < 0 ? 1.04 + (-0.6 - y) / (-0.6 - base) * 0.21 : 1.0;
      const P = legs.map(([lx, lz]) => V(lx * k, y, lz * k));
      for (let i = 0; i < 4; i++) beam(g, P[i], P[(i + 1) % 4], 0.35, y < 0 ? rust : steel);
    }
    for (let i = 0; i < 4; i++) {
      const [ax, az] = legs[i], [bx, bz] = legs[(i + 1) % 4];
      beam(g, V(ax * 1.02, 1, az * 1.02), V(bx, 12.5, bz), 0.25, steel);
      beam(g, V(bx * 1.02, 1, bz * 1.02), V(ax, 12.5, az), 0.25, steel);
    }
    const box = (w: number, h: number, d: number, m: THREE.Material, px: number, py: number, pz: number): THREE.Mesh => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      b.position.set(px, py, pz); b.castShadow = true; g.add(b);
      return b;
    };
    box(34, 1.2, 34, deckM, 0, top, 0);
    box(30, 1, 30, deckM, 0, top + 6.5, 0);
    for (const [px, pz] of [[-14, -14], [14, -14], [14, 14], [-14, 14]] as const) beam(g, V(px, top + 0.6, pz), V(px, top + 6, pz), 0.45, steel);
    box(14, 5.5, 10, whiteM, -6, top + 3.3, -8);
    box(14, 1, 10, orangeM, -6, top + 6.2, -8);
    box(8, 4, 8, orangeM, 8, top + 2.6, 6);
    box(6, 9, 6, whiteM, 9, top + 11, -9);
    const heli = new THREE.Mesh(new THREE.CylinderGeometry(8, 8, 0.5, 24), heliM);
    heli.position.set(-8, top + 12.6, 6); g.add(heli);
    beam(g, V(-8, top + 7, 6), V(-8, top + 12.3, 6), 0.6, steel);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(5, 0.18, 6, 32), new THREE.MeshBasicMaterial({ color: 0xf2c14e }));
    ring.rotation.x = Math.PI / 2; ring.position.set(-8, top + 12.9, 6); g.add(ring);
    beam(g, V(12, top + 7, 12), V(12, top + 12, 12), 0.7, steel);
    beam(g, V(12, top + 12, 12), V(-4, top + 22, 20), 0.35, orangeM);
    beam(g, V(17, top + 6, -6), V(36, top + 16, -12), 0.4, steel);
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(9, 9), flameM);
    fl.position.set(37, top + 17.5, -12.5); g.add(fl);
    box(6, 0.4, 3, deckM, H + 3, 1.6, 0);
    beam(g, V(H + 3, 1.8, -1.5), V(H, top, -1.5), 0.15, steel);
    beam(g, V(H + 3, 1.8, 1.5), V(H, top, 1.5), 0.15, steel);
    for (const [px, pz] of [[-16, -16], [16, -16], [16, 16], [-16, 16], [0, 0]] as const) {
      const sp = new THREE.Sprite(lampM); sp.scale.setScalar(5); sp.position.set(px, top + 7.5, pz); g.add(sp);
    }
    g.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = true; });
    rigs.push({ x, z, g, fl, fish: 999, twin: false, told: false });
    rigs.push({ x: x + 18, z: z - 14, fish: 999, twin: true, told: false });
  });
  return rigs;
}

export interface HotspotWorld {
  update(dt: number, t: number, boat: { x: number; z: number }, camera: { x: number; z: number }, particles: ParticleSystem): void;
  /** `audio/engine.ts`'s `AudioFrameInputs.gullSites` — legacy `AUD.gull`'s nearest-hotspot pick
   * (index.html:3214). Hotspots only (rigs/weeds carry their own, much sparser bird life). */
  gullSites(): GullSite[];
  /** Read-only query helpers for whoever wires rod/spear fishing's zone bonuses — legacy
   * `nearRig`/`nearWeed` (index.html:2133-2134). */
  nearRig(x: number, z: number, r?: number): Rig | null;
  nearWeed(x: number, z: number, extra?: number): WeedPatch | null;
  /** Raw snapshots for `stubs.ts`'s `installWorldLife` — see that module's header; membership is
   * fixed after construction (only each site's internal position/animation state mutates in
   * place), so a one-time call after `createHotspotWorld` stays accurate. */
  listRigs(): readonly Rig[];
  listWeeds(): readonly WeedPatch[];
  listHotspots(): readonly Hotspot[];
}

/** Builds and animates hotspots, weedlines and oil rigs — legacy's `hotspots`/`WEEDS`/`RIGS`
 * module-level arrays plus `updateHotspots`/`updateWeeds`/`updateRigs`. */
export function createHotspotWorld(scene: THREE.Scene, lightMats: LightMatEntry[]): HotspotWorld {
  const hotspots: Hotspot[] = [];
  (Object.keys(HS_COUNTS) as Zone[]).forEach((zone) => {
    for (let i = 0; i < HS_COUNTS[zone]; i++) {
      const h = spawnHotspot(scene, zone, i);
      if (h) hotspots.push(h);
    }
  });
  const weeds = spawnWeedPatches(scene);
  const rigs = spawnRigs(scene, lightMats);
  const dummy = new THREE.Object3D();

  return {
    update(dt, t, boat, camera, particles) {
      // ---- hotspots: feeding frenzies come and go; birds circle and, during a frenzy, plunge ----
      for (const h of hotspots) {
        h.fT -= dt;
        if (h.fT <= 0) { h.active = !h.active; h.fT = h.active ? rand(14, 28) : rand(10, 26); }
        h.fr = lerp(h.fr, h.active ? 1 : 0, Math.min(1, dt * 0.7));
        const fr = h.fr;
        const dCam = Math.hypot(h.x - camera.x, h.z - camera.z);
        const near = dCam < 900;
        h.g.visible = dCam < 1100;
        if (h.g.visible) {
          h.birds.forEach((b) => {
            const a = t * b.sp * (1 + fr * 0.6) + b.ph, R = b.r * (1 - 0.35 * fr), Hh = b.h * (1 - 0.4 * fr);
            const cx = Math.cos(a) * R, cy = Hh + Math.sin(t * 1.3 + b.ph), cz = Math.sin(a) * R;
            if (!b.dive && fr > 0.45 && Math.random() < dt * 0.3) b.dive = { t: 0, tx: rand(-9, 9), tz: rand(-9, 9), spl: 0 };
            if (b.dive) {
              const D = b.dive;
              D.t += dt;
              const p = D.t / 1.8;
              let x: number, y: number, z: number, flap = 0, tuck = 0;
              if (p < 0.45) { const q = p / 0.45; x = lerp(cx, D.tx, q); z = lerp(cz, D.tz, q); y = lerp(cy, 0.3, q * q); tuck = Math.min(1, q * 1.6); }
              else if (p < 0.62) {
                x = D.tx; z = D.tz; y = 0.05; tuck = 1;
                if (!D.spl) { D.spl = 1; if (near) particles.splash(h.x + D.tx, h.z + D.tz, 8, 0.8); }
              } else { const q = (p - 0.62) / 0.38; x = lerp(D.tx, cx, q); z = lerp(D.tz, cz, q); y = lerp(0.3, cy, q); flap = 1; }
              if (p >= 1) b.dive = null;
              poseBird(b.B, dt, flap, tuck, 12);
              moveBird(b.B, x, y, z, dt);
            } else {
              const flap = Math.sin(t * 0.8 + b.ph) > 0.1 || fr > 0.5 ? 1 : 0;
              poseBird(b.B, dt, flap, 0, 9 + fr * 3);
              moveBird(b.B, cx, cy, cz, dt);
            }
          });
          h.weeds.forEach((w) => { w.position.y = waveHBase(h.x + w.position.x, h.z + w.position.z, t, h.amp) + 0.05; });
        }
        if (!near) continue;
        // the surface boils: fish busting bait, white water and bubbles, little silver baitfish spraying out
        if (Math.random() < dt * (0.8 + 7 * fr)) {
          const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * 10;
          particles.splash(h.x + Math.cos(a) * r, h.z + Math.sin(a) * r, 4 + Math.floor(fr * 10), 0.6 + fr * 0.7);
        }
        for (let k = 0; k < fr * dt * 28; k++) {
          const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * 11;
          particles.spawnP(h.x + Math.cos(a) * r, 0.1, h.z + Math.sin(a) * r, rand(-0.3, 0.3), 0, rand(-0.3, 0.3), rand(1.5, 3), rand(0.8, 2), 0.55, false, h.amp);
        }
        for (let k = 0; k < fr * dt * 24; k++) {
          const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * 9, v = rand(1.5, 3.5);
          particles.spawnP(h.x + Math.cos(a) * r, 0.15, h.z + Math.sin(a) * r, Math.cos(a) * v, rand(2, 4.5), Math.sin(a) * v, rand(0.4, 0.8), rand(0.18, 0.32), 0.95, true);
        }
        if (fr > 0.6 && !h.told && Math.hypot(h.x - boat.x, h.z - boat.z) < 320) { h.told = true; toast('Birds diving and fish busting bait — that’s a hot spot! Cast into it.'); }
      }

      // ---- weedlines: drift slowly, frigatebirds circle overhead ----
      for (const w of weeds) {
        w.x += 0.22 * dt; w.z += 0.05 * dt;
        const d = Math.hypot(w.x - camera.x, w.z - camera.z);
        const vis = d < 1100;
        w.im.visible = vis; w.bg.visible = vis;
        if (d > 800) continue;
        w.off.forEach((o, i) => {
          const x = w.x + o[0], z = w.z + o[1];
          dummy.position.set(x, waveHBase(x, z, t, w.amp) + 0.04, z);
          dummy.rotation.set(0, o[3], 0);
          dummy.scale.set(o[2], 0.18, o[2] * 0.8);
          dummy.updateMatrix();
          w.im.setMatrixAt(i, dummy.matrix);
        });
        w.im.instanceMatrix.needsUpdate = true;
        w.bg.position.set(w.x, 0, w.z);
        w.birds.forEach((b) => {
          const a = t * b.sp + b.ph;
          poseBird(b.B, dt, Math.sin(t * 0.35 + b.ph) > 0.88 ? 1 : 0, 0, b.B.kind === 'frigate' ? 5 : 9);
          moveBird(b.B, Math.cos(a) * b.r, b.h + Math.sin(t + b.ph), Math.sin(a) * b.r, dt);
        });
        if (!w.told && Math.hypot(w.x - boat.x, w.z - boat.z) < 250) { w.told = true; toast('Weedline ahead — mahi love to hang under the weeds.'); }
      }

      // ---- oil rigs: visible from far out, flare flickering, told once on approach ----
      for (const R of rigs) {
        if (!R.g || !R.fl) continue;
        const near = Math.hypot(R.x - camera.x, R.z - camera.z) < 2500;
        R.g.visible = near;
        if (!near) continue;
        R.fl.lookAt(camera.x, R.fl.position.y, camera.z);
        R.fl.scale.set(1 + 0.15 * Math.sin(t * 9 + R.x), 1 + 0.25 * Math.sin(t * 7.3), 1);
        if (!R.told && Math.hypot(R.x - boat.x, R.z - boat.z) < 450) { R.told = true; toast('Oil rig ahead — amberjack, cobia and tuna stack up around the legs.'); }
      }
    },
    gullSites(): GullSite[] { return hotspots.map((h) => ({ x: h.x, z: h.z })); },
    nearRig(x, z, r = 60): Rig | null {
      for (const R of rigs) if (R.g && R.fl && Math.hypot(R.x - x, R.z - z) < r) return R;
      return null;
    },
    nearWeed(x, z, extra = 25): WeedPatch | null {
      for (const w of weeds) {
        const dx = x - w.x, dz = z - w.z;
        const u = dx * Math.cos(w.ang) + dz * Math.sin(w.ang), v = -dx * Math.sin(w.ang) + dz * Math.cos(w.ang);
        if (Math.abs(u) < w.len / 2 + extra && Math.abs(v) < w.wid / 2 + extra) return w;
      }
      return null;
    },
    listRigs(): readonly Rig[] { return rigs; },
    listWeeds(): readonly WeedPatch[] { return weeds; },
    listHotspots(): readonly Hotspot[] { return hotspots; },
  };
}
