/**
 * The five residences of the build sheet, low-poly and flat-shaded like the rest of the game's
 * buildings. Each is built in its own frame: origin on the ground at the footprint's centre,
 * `w` across (x), `d` deep (z), the front — and the view — facing +z, which index.ts turns to
 * `siteLayout`'s seaward `heading`.
 *
 * Every residence (but the stilt house, which stands on pilings by design) sits on a plinth that
 * runs 2.5 m below its floor, so a lot that slopes under the footprint never shows daylight under
 * the house.
 */
import * as THREE from 'three';
import type { ResidenceKey } from '@keysrun/shared/content/estates';
import { box, cyl, mats } from './materials.js';

export interface Residence {
  group: THREE.Group;
  /** Height of the lintel over the front door: where a 'door' mount hangs. */
  doorTop: number;
  /** Local z of the front wall's face. */
  frontZ: number;
}

/** A four-sided hip roof over a w×d rectangle. */
function hipRoof(w: number, d: number, h: number, m: THREE.Material, y: number): THREE.Mesh {
  const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1).rotateY(Math.PI / 4);
  const mesh = new THREE.Mesh(g, m);
  mesh.scale.set(w * 1.08, h, d * 1.08);
  mesh.position.y = y + h / 2;
  mesh.castShadow = true;
  return mesh;
}

/** A gable roof (ridge along x) over a w×d rectangle. */
function gableRoof(w: number, d: number, h: number, m: THREE.Material, y: number): THREE.Mesh {
  const s = new THREE.Shape();
  s.moveTo(-d / 2 - 0.4, 0); s.lineTo(d / 2 + 0.4, 0); s.lineTo(0, h); s.lineTo(-d / 2 - 0.4, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: w + 0.6, bevelEnabled: false }).translate(0, 0, -(w + 0.6) / 2).rotateY(Math.PI / 2);
  const mesh = new THREE.Mesh(g, m);
  mesh.position.y = y;
  mesh.castShadow = true;
  return mesh;
}

/** A row of windows on the front face of a box. */
function windows(g: THREE.Group, w: number, z: number, y: number, n: number, ww = 1.4, wh = 1.5): void {
  const M = mats();
  for (let i = 0; i < n; i++) {
    const x = -w / 2 + (w / n) * (i + 0.5);
    g.add(box(ww, wh, 0.08, M.window, x, y, z + 0.04));
  }
}

function plinth(g: THREE.Group, w: number, d: number, m: THREE.Material, top = 0.3): void {
  g.add(box(w, 2.5 + top, d, m, 0, -2.5, 0));
}

function villa(w: number, d: number): Residence {
  const M = mats(), g = new THREE.Group();
  plinth(g, w + 1, d + 1, M.stone);
  // ground floor across the whole footprint, a smaller first floor set back, terracotta hips
  g.add(box(w, 4, d, M.stucco, 0, 0.3, 0));
  windows(g, w, d / 2, 1.5, Math.max(3, Math.round(w / 5)), 1.6, 2.2);
  const uw = w * 0.7, ud = d * 0.65;
  g.add(box(uw, 3.6, ud, M.stucco, 0, 4.3, -d * 0.12));
  windows(g, uw, -d * 0.12 + ud / 2, 5.2, Math.max(2, Math.round(uw / 5)));
  g.add(hipRoof(uw, ud, 2.6, M.terracotta, 7.9).translateZ(-d * 0.12));
  // the ground floor's flat roof is the first floor's terrace, railed
  g.add(box(w, 0.3, d, M.white, 0, 4.3, 0));
  g.add(box(w, 0.9, 0.12, M.white, 0, 4.6, d / 2 - 0.06));
  // a deep pool deck across the front
  g.add(box(w + 2, 0.35, 7, M.deck, 0, 0, d / 2 + 3.5));
  g.add(box(w * 0.55, 0.12, 4.2, M.water, -w * 0.15, 0.3, d / 2 + 3.6));
  // door + columns
  g.add(box(2.2, 2.9, 0.12, M.trim, w * 0.3, 0.3, d / 2 + 0.06));
  for (const x of [-w / 2 + 0.4, w / 2 - 0.4]) g.add(cyl(0.25, 0.3, 4, M.white, x, 0.3, d / 2 + 0.3));
  return { group: g, doorTop: 3.6, frontZ: d / 2 + 0.12 };
}

function shack(w: number, d: number): Residence {
  const M = mats(), g = new THREE.Group();
  plinth(g, w, d + 3, M.darkWood);
  g.add(box(w, 2.8, d, M.wood, 0, 0.3, 0));
  windows(g, w, d / 2, 1.2, 2, 1, 1);
  // a lean of corrugated tin, overhanging the porch
  const roof = box(w + 1, 0.12, d + 3.4, M.tin, 0, 0, 1.2);
  roof.position.y = 3.6; roof.rotation.x = 0.16;
  g.add(roof);
  // porch: planks, posts, a cooler and a rod leaning on the wall
  g.add(box(w, 0.2, 2.8, M.deck, 0, 0.3, d / 2 + 1.4));
  for (const x of [-w / 2 + 0.2, w / 2 - 0.2]) g.add(box(0.18, 2.6, 0.18, M.darkWood, x, 0.5, d / 2 + 2.6));
  g.add(box(0.9, 0.5, 0.5, M.cooler, w / 2 - 1.2, 0.5, d / 2 + 1.2));
  g.add(box(0.92, 0.1, 0.52, M.coolerLid, w / 2 - 1.2, 1.0, d / 2 + 1.2));
  const rod = cyl(0.015, 0.025, 3, M.trim, -w / 2 + 0.8, 0.5, d / 2 + 0.3, 5);
  rod.rotation.z = 0.25;
  g.add(rod);
  g.add(box(1.1, 2.2, 0.1, M.darkWood, 0.6, 0.3, d / 2 + 0.05));
  return { group: g, doorTop: 2.7, frontZ: d / 2 + 0.1 };
}

function garden(w: number, d: number): Residence {
  const M = mats(), g = new THREE.Group();
  // The garden fills the footprint and more; the tea house is the building at its back.
  const gw = w * 2.4, gd = d * 2.4;
  g.add(box(gw, 0.25, gd, M.lawn, 0, -0.1, 0));
  // raked gravel with its lines, at the front
  const gravel = box(gw * 0.55, 0.06, gd * 0.38, M.gravel, gw * 0.18, 0.15, gd * 0.22);
  g.add(gravel);
  for (let i = 0; i < 7; i++) g.add(box(gw * 0.52, 0.03, 0.08, M.stone, gw * 0.18, 0.21, gd * 0.22 - gd * 0.17 + i * gd * 0.055));
  g.add(box(1.4, 0.9, 1.1, M.stone, gw * 0.3, 0.15, gd * 0.25));
  // koi pond and its fish
  const pond = cyl(gw * 0.16, gw * 0.16, 0.08, M.koiWater, -gw * 0.24, 0.12, gd * 0.18, 20);
  pond.scale.z = 0.7;
  g.add(pond);
  for (let i = 0; i < 5; i++) g.add(box(0.5, 0.06, 0.18, M.koi, -gw * 0.24 + Math.cos(i * 1.3) * gw * 0.08, 0.2, gd * 0.18 + Math.sin(i * 1.3) * gw * 0.05));
  for (let i = 0; i < 6; i++) g.add(cyl(0.45, 0.5, 0.12, M.stone, -gw * 0.05 + i * 0.3, 0.12, gd * 0.38 - i * 1.4, 8));
  // tea house: dark timber on a low platform, a broad flared roof
  const tz = -d * 0.35;
  g.add(box(w + 2, 0.6, d + 2, M.darkWood, 0, 0, tz));
  g.add(box(w, 2.8, d, M.white, 0, 0.6, tz));
  for (const x of [-w / 2, -w / 6, w / 6, w / 2]) g.add(box(0.22, 2.8, 0.22, M.darkWood, x, 0.6, tz + d / 2));
  g.add(hipRoof(w + 3, d + 3, 2.4, M.slate, 3.4).translateZ(tz));
  // hedges round the edge
  for (const s of [-1, 1]) g.add(box(0.9, 1.2, gd, M.hedge, s * (gw / 2 - 0.45), 0.1, 0));
  g.add(box(gw, 1.2, 0.9, M.hedge, 0, 0.1, -gd / 2 + 0.45));
  return { group: g, doorTop: 3.0, frontZ: tz + d / 2 + 0.12 };
}

function stilt(w: number, d: number): Residence {
  const M = mats(), g = new THREE.Group();
  const floor = 3.2;
  for (const x of [-w / 2 + 0.4, 0, w / 2 - 0.4]) for (const z of [-d / 2 + 0.4, 0, d / 2 - 0.4]) g.add(cyl(0.22, 0.26, floor + 4, M.darkWood, x, -4, z, 7));
  g.add(box(w + 3, 0.35, d + 3, M.deck, 0, floor, 0));
  g.add(box(w, 3, d, M.stuccoBlue, 0, floor + 0.35, 0));
  windows(g, w, d / 2, floor + 1.3, 3, 1.2, 1.3);
  g.add(gableRoof(w, d, 2.4, M.tin, floor + 3.35));
  // wraparound rail and the stair down to the ground
  for (const z of [-(d + 3) / 2, (d + 3) / 2]) g.add(box(w + 3, 0.9, 0.08, M.white, 0, floor + 0.35, z));
  const stair = box(1.4, 0.2, Math.hypot(floor, 5), M.deck, -w / 2 - 0.8, 0, 0);
  stair.position.set(-w / 2 - 2.2, floor / 2, d / 2 - 1);
  stair.rotation.x = Math.atan2(floor, 5);
  g.add(stair);
  g.add(box(1.4, 2.4, 0.1, M.trim, w * 0.25, floor + 0.35, d / 2 + 0.05));
  return { group: g, doorTop: floor + 2.9, frontZ: d / 2 + 0.1 };
}

function glass(w: number, d: number): Residence {
  const M = mats(), g = new THREE.Group();
  plinth(g, w + 1, d + 1, M.white);
  // a glass box under a cantilevered white slab, a dark core at the back
  g.add(box(w * 0.35, 3.4, d * 0.4, M.trim, -w * 0.2, 0.3, -d * 0.25));
  g.add(box(w, 3.4, d, M.glass, 0, 0.3, 0));
  g.add(box(w + 3, 0.45, d + 2.5, M.white, 0, 3.7, 0.6));
  g.add(box(w * 0.55, 2.8, d * 0.75, M.glass, w * 0.15, 4.15, -d * 0.08));
  g.add(box(w * 0.55 + 1.5, 0.35, d * 0.75 + 1.5, M.white, w * 0.15, 6.95, -d * 0.08));
  for (const x of [-w / 2, 0, w / 2]) g.add(box(0.14, 3.4, 0.14, M.white, x, 0.3, d / 2));
  // the infinity pool: water level with its own far edge, seaward
  g.add(box(w + 2, 0.45, 7, M.white, 0, 0, d / 2 + 3.5));
  g.add(box(w * 0.8, 0.08, 5, M.water, 0, 0.45, d / 2 + 4));
  return { group: g, doorTop: 3.4, frontZ: d / 2 + 0.1 };
}

export function buildResidence(res: ResidenceKey, w: number, d: number): Residence {
  switch (res) {
    case 'villa': return villa(w, d);
    case 'shack': return shack(w, d);
    case 'garden': return garden(w, d);
    case 'stilt': return stilt(w, d);
    case 'glass': return glass(w, d);
  }
}
