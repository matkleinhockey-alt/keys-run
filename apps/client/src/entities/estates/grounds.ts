/**
 * Everything on an estate that isn't the house: the dock, the hung fish and its mount, the
 * trophies round the grounds, the pool, the fire pit, and the owner's board at the water.
 *
 * All of it is placed from `siteLayout` (packages/shared/src/content/estates.ts) and stood on
 * `EstateSite.groundY`, which is the walk surface's own answer (`estateGround`) wherever there is
 * one — so the dock you see is exactly the dock you walk on.
 */
import * as THREE from 'three';
import { SPECIES } from '@keysrun/shared/content/species';
import { scaledLenM } from '@keysrun/shared/sim/fight';
import { DOCK_RAMP, ESTATE_DOCK_TOP, TIERS, type Build, type Estate, type Parcel, type SiteLayout } from '@keysrun/shared/content/estates';
import { landH } from '@keysrun/shared/world/depth';
import { beamBetween } from '../boat/hull.js';
import { makeFishMesh } from '../../game/fishing/fish-mesh.js';
import { box, cyl, mats, signMesh } from './materials.js';

export interface EstateSite {
  parcel: Parcel;
  estate: Estate;
  layout: SiteLayout;
  /** Height of what you stand on at (x, z) on this lot — dock, ramp, lot ground or town pad. */
  groundY(x: number, z: number): number;
  /** The lot vertex furthest out along `layout.sea`: where land meets water. */
  shore: [number, number];
}

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

/** Species a trophy wall is made of, biggest-game first; a lot's trophies cycle through them. */
const TROPHY_SPECIES = ['sailfish', 'mahi', 'tarpon', 'wahoo', 'grouper', 'yellowfin', 'permit', 'snook', 'amberjack', 'cobia'];

/** A fish mounted the way a taxidermist shows one: length along local z, flank to local +x —
 * which the callers turn to face the water. Wrapped so a caller can pitch it without fighting
 * the mesh's own scale. */
function mountedFish(key: string, lenM: number): THREE.Group {
  const g = new THREE.Group();
  g.add(makeFishMesh(SPECIES[key].color, lenM));
  return g;
}

export function buildDock(site: EstateSite, build: Build): THREE.Group | null {
  const d = site.layout.dock;
  if (!d) return null;
  const M = mats(), g = new THREE.Group();
  const [sx, sz] = site.layout.sea;
  g.position.set(d.x0, 0, d.z0);
  g.rotation.y = Math.atan2(sx, sz); // local +z runs out along the dock
  const g0 = Math.max(0.3, landH(d.x0, d.z0));
  // The ramp: one plank slab from the lot up to deck height, exactly as `estateGround` slopes it.
  const rampLen = Math.hypot(DOCK_RAMP, ESTATE_DOCK_TOP - g0);
  const ramp = box(d.w, 0.25, rampLen, M.deck);
  ramp.position.set(0, (g0 + ESTATE_DOCK_TOP) / 2 - 0.125, DOCK_RAMP / 2);
  ramp.rotation.x = -Math.atan2(ESTATE_DOCK_TOP - g0, DOCK_RAMP);
  g.add(ramp);
  g.add(box(d.w, 0.3, d.len - DOCK_RAMP, M.deck, 0, ESTATE_DOCK_TOP - 0.3, DOCK_RAMP + (d.len - DOCK_RAMP) / 2));
  // pilings along both edges
  for (let z = DOCK_RAMP; z <= d.len; z += 4) {
    for (const s of [-1, 1]) g.add(cyl(0.16, 0.19, ESTATE_DOCK_TOP + 3.6, M.darkWood, s * (d.w / 2 + 0.05), -3, z, 6));
  }
  if (d.tHead) {
    g.add(box(d.tHead, 0.3, 5, M.deck, 0, ESTATE_DOCK_TOP - 0.3, d.len - 2.5));
    for (const x of [-d.tHead / 2, -d.tHead / 4, d.tHead / 4, d.tHead / 2]) g.add(cyl(0.18, 0.2, ESTATE_DOCK_TOP + 3.6, M.darkWood, x, -3, d.len - 0.2, 6));
    // The helipad: its own square on pilings off the T-head's end, landing circle and H.
    const hx = -d.tHead / 2 - 6.5, hz = d.len - 2.5;
    g.add(box(12, 0.4, 12, M.helipad, hx, ESTATE_DOCK_TOP - 0.4, hz));
    for (const [ox, oz] of [[-5, -5], [5, -5], [-5, 5], [5, 5]]) g.add(cyl(0.22, 0.25, ESTATE_DOCK_TOP + 3.6, M.darkWood, hx + ox, -3, hz + oz, 6));
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.6, 4.1, 32).rotateX(-Math.PI / 2), M.helipadMark);
    ring.position.set(hx, ESTATE_DOCK_TOP + 0.01, hz);
    g.add(ring);
    for (const ox of [-1, 1]) g.add(box(0.4, 0.02, 3, M.helipadMark, hx + ox, ESTATE_DOCK_TOP, hz));
    g.add(box(2, 0.02, 0.4, M.helipadMark, hx, ESTATE_DOCK_TOP, hz));
  }
  // cleats and a dock box at the end
  for (const s of [-1, 1]) g.add(box(0.35, 0.12, 0.12, M.steel, s * (d.w / 2 - 0.2), ESTATE_DOCK_TOP, d.len - 1));
  if (build.dock !== 'skiff') g.add(box(1.4, 0.7, 0.7, M.white, d.w / 2 - 0.5, ESTATE_DOCK_TOP, DOCK_RAMP + 2));
  return g;
}

/** The weigh-station gallows (beside the dock, on its own platform if that is over water), a
 * garden pedestal, or — for 'door' — nothing here: the house carries that one (see `doorMount`). */
export function buildMount(site: EstateSite, build: Build): THREE.Group | null {
  if (build.mount === 'door') return null;
  const M = mats(), g = new THREE.Group();
  const { x, z } = site.layout.mount;
  const lenM = scaledLenM(build.fish, build.lb);
  const S = SPECIES[build.fish];
  const land = landH(x, z);
  const base = build.mount === 'gallows' && land < 0.3 ? ESTATE_DOCK_TOP : site.groundY(x, z);
  g.position.set(x, base, z);
  g.rotation.y = site.layout.heading + Math.PI / 2; // local +x faces the water: read from a boat

  if (build.mount === 'gallows') {
    if (land < 0.3) {
      g.add(box(3.4, 0.3, 3.4, M.deck, 0, -0.3, 0));
      for (const [ox, oz] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) g.add(cyl(0.14, 0.16, base + 3.4, M.darkWood, ox, -base - 3.1, oz, 6));
    }
    const top = Math.max(3.6, lenM + 2.2), half = Math.max(1.1, lenM * 0.35);
    g.add(beamBetween(V(0, 0, -half), V(0, top, -half), 0.09, M.wood));
    g.add(beamBetween(V(0, 0, half), V(0, top, half), 0.09, M.wood));
    g.add(beamBetween(V(0, top, -half - 0.15), V(0, top, half + 0.15), 0.08, M.wood));
    const scale = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.06, 20), M.red);
    scale.rotation.z = Math.PI / 2; scale.position.set(0, top - 0.3, 0);
    g.add(scale);
    g.add(beamBetween(V(0, top, 0), V(0, top - 0.24, 0), 0.01, M.steel));
    g.add(beamBetween(V(0, top - 0.36, 0), V(0, top - 0.6, 0), 0.01, M.steel));
    const fish = makeFishMesh(S.color, lenM);
    fish.rotation.set(-Math.PI / 2, 0, 0);
    fish.position.set(0, top - 0.6 - lenM / 2, 0);
    g.add(fish);
    const sign = signMesh([['bold 44px system-ui, sans-serif', S.name.toUpperCase()], ['bold 70px system-ui, sans-serif', `${build.lb.toFixed(1)} LB`]], 1.9, 0.95);
    sign.rotation.y = Math.PI / 2;
    sign.position.set(0.03, top + 0.65, 0);
    g.add(sign);
  } else {
    // pedestal: a stone column, the fish leaping off it
    g.add(box(1.1, 0.3, 1.1, M.stone, 0, 0, 0));
    g.add(cyl(0.3, 0.38, 1.3, M.stone, 0, 0.3, 0, 8));
    g.add(beamBetween(V(0, 1.6, 0), V(0, 2.0, 0), 0.03, M.steel));
    const fish = mountedFish(build.fish, lenM);
    fish.rotation.x = -0.35; // nose up, leaping
    fish.position.set(0, 2.0 + lenM * 0.12, 0);
    g.add(fish);
    const sign = signMesh([['bold 40px system-ui, sans-serif', S.name.toUpperCase()], ['bold 64px system-ui, sans-serif', `${build.lb.toFixed(1)} LB`]], 1.0, 0.5);
    sign.rotation.y = Math.PI / 2;
    sign.position.set(0.42, 1.0, 0);
    g.add(sign);
  }
  return g;
}

/** The 'door' mount: a varnished board over the front door, in the house's own frame. */
export function doorMount(build: Build, doorTop: number, frontZ: number): THREE.Group {
  const M = mats(), g = new THREE.Group();
  const lenM = Math.min(scaledLenM(build.fish, build.lb), 4.5);
  const S = SPECIES[build.fish];
  g.add(box(lenM + 0.6, Math.max(0.8, lenM * 0.32), 0.1, M.darkWood, 0, doorTop + 0.3, frontZ + 0.05));
  const fish = makeFishMesh(S.color, lenM);
  fish.rotation.y = Math.PI / 2;
  fish.position.set(0, doorTop + 0.3 + Math.max(0.8, lenM * 0.32) / 2, frontZ + 0.3);
  g.add(fish);
  const sign = signMesh([['bold 40px system-ui, sans-serif', S.name.toUpperCase()], ['bold 64px system-ui, sans-serif', `${build.lb.toFixed(1)} LB`]], 0.9, 0.45);
  sign.position.set(0, doorTop + 0.05, frontZ + 0.2);
  g.add(sign);
  return g;
}

export function buildTrophies(site: EstateSite): THREE.Group {
  const M = mats(), g = new THREE.Group();
  site.layout.trophies.forEach((t, i) => {
    const key = TROPHY_SPECIES[(i + site.parcel.id.length) % TROPHY_SPECIES.length];
    const S = SPECIES[key];
    const lenM = Math.min(2.2, scaledLenM(key, (S.min + S.max) * 0.6));
    const p = new THREE.Group();
    p.position.set(t.x, site.groundY(t.x, t.z), t.z);
    p.rotation.y = site.layout.heading + Math.PI / 2;
    p.add(box(0.9, 1.0, 0.9, M.white, 0, 0, 0));
    p.add(box(1.0, 0.08, 1.0, M.stone, 0, 1.0, 0));
    p.add(beamBetween(V(0, 1.08, 0), V(0, 1.5, 0), 0.025, M.steel));
    const fish = mountedFish(key, lenM);
    fish.position.y = 1.5 + lenM * 0.08;
    fish.rotation.x = -0.2;
    p.add(fish);
    g.add(p);
  });
  return g;
}

export function buildPool(site: EstateSite): THREE.Group | null {
  const at = site.layout.pool;
  if (!at) return null;
  const M = mats(), g = new THREE.Group();
  g.position.set(at.x, site.groundY(at.x, at.z), at.z);
  g.rotation.y = site.layout.heading;
  g.add(box(9, 0.4, 5.5, M.white, 0, -0.2, 0));
  g.add(box(8, 0.06, 4.5, M.water, 0, 0.17, 0));
  for (const x of [-2, 0, 2]) g.add(box(0.7, 0.3, 1.9, M.white, x, 0.2, 3.8)); // loungers
  return g;
}

export function buildFirepit(site: EstateSite): { group: THREE.Group; flame: THREE.Mesh } | null {
  const at = site.layout.firepit;
  if (!at) return null;
  const M = mats(), g = new THREE.Group();
  g.position.set(at.x, site.groundY(at.x, at.z), at.z);
  for (let i = 0; i < 9; i++) { const a = (i / 9) * Math.PI * 2; g.add(box(0.4, 0.35, 0.3, M.stone, Math.cos(a) * 0.8, 0, Math.sin(a) * 0.8)); }
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.9, 6), M.fire);
  flame.position.y = 0.45;
  g.add(flame);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const chair = box(0.7, 0.45, 0.7, M.wood, Math.cos(a) * 2.4, 0, Math.sin(a) * 2.4);
    chair.rotation.y = -a + Math.PI / 2;
    g.add(chair);
  }
  return { group: g, flame };
}

/** The board at the waterline, beside the dock, that says whose estate this is. */
export function buildOwnerBoard(site: EstateSite): THREE.Group {
  const M = mats(), g = new THREE.Group();
  const [sx, sz] = site.layout.sea;
  const ax = -sz, az = sx;
  const off = site.layout.dock ? -(site.layout.dock.w / 2 + 5) : 0;
  // a few metres back up the beach from the shore point, so it stands on the lot
  let x = site.shore[0] + ax * off - sx * 4, z = site.shore[1] + az * off - sz * 4;
  if (site.parcel.tier === 'harbor') {
    // in front of the (turned-round, see index.ts) house, past its terrace, at the lot's corner
    const H = site.layout.house, k = H.d / 2 + 8.5, c = H.w / 2 - 2;
    x = H.x - sx * k + ax * c; z = H.z - sz * k + az * c;
  }
  g.position.set(x, site.groundY(x, z), z);
  g.rotation.y = site.layout.heading + (site.parcel.tier === 'harbor' ? Math.PI : 0);
  for (const s of [-1, 1]) g.add(box(0.16, 2.6, 0.16, M.darkWood, s * 1.5, 0, 0));
  const e = site.estate;
  const sign = signMesh([
    ['bold 58px system-ui, sans-serif', e.ownerName],
    ['bold 34px system-ui, sans-serif', site.parcel.name],
    ['26px system-ui, sans-serif', e.founding ? 'Founding estate · Keys Run Estates' : `${TIERS[site.parcel.tier].label} · Keys Run Estates`],
  ], 3.4, 1.7);
  sign.position.set(0, 1.9, 0.1);
  g.add(sign);
  return g;
}
