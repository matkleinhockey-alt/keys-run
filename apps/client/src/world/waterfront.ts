/**
 * Waterfront estates: the houses people actually keep boats at.
 *
 * The islands were scattered with one conch house — a 6 x 3.4 m box with a cone on it,
 * instanced, identical everywhere — and nothing else. No pools, no docks, and so nowhere in the
 * whole world that a private boat was kept, which is strange in a place where every house on the
 * water has a lift at the end of its dock and something hanging in it.
 *
 * So: a handful of proper waterfront places, each one a house, a pool, a dock out to water deep
 * enough to float a boat, a lift at the end of it with a centre console sitting up out of the
 * water, and often a speedboat tied off alongside.
 *
 * ## Where they go
 *
 * Deterministically, by walking each coastal island's real OSM shoreline and testing candidates
 * the way `islands.ts` tests its own scenery: off the town footprint, off US-1 and the golf
 * courses, clear of the creeks, on ground that is actually above water, and — the one that
 * matters here and nowhere else — with enough depth off the end of the dock to keep a boat.
 * A house with its lift in six inches of water is a house nobody would have built.
 *
 * The outward direction comes from the gradient of `islandDist`, which is signed (negative
 * inside), so the dock runs down the steepest way out of the land rather than away from the
 * island's centre. On a real coastline with bays and spits those are not the same direction, and
 * using the centre puts docks through the neighbour's garden.
 */
import * as THREE from 'three';
import { hashCell } from '@keysrun/shared/rng';
import { islands, islandDist, chainZ, type Island } from '@keysrun/shared/world/chain';
import { landH, depthAt, onCourse, creekDist } from '@keysrun/shared/world/depth';
import { inTownFootprint } from '@keysrun/shared/world/town';
import type { DockRect } from '@keysrun/shared/sim/boat';
import { islandLocal } from '@keysrun/shared/world/chain';
import { makeDockBoat } from './marinas.js';
import { grainTex, normalTex } from '../core/textures.js';
import { lerp } from '../core/math.js';
import { WORLD_SEED, SALT } from '../state/constants.js';

/** Estates per island, at most. Rare on purpose: these are the big places, not every lot. */
const PER_ISLAND = 7;
/** Candidate shore samples walked per island. */
const TRIES = 320;
/** Metres between estates — enough that two never share a garden. */
const SPACING_M = 150;
/** How far the house sits back from the water. */
const SETBACK_M = 26;
/** The dock has to reach water at least this deep, or the lift is pointless. */
const MIN_DOCK_DEPTH = 1.15;
/** ...and it will not run further than this looking for it. */
const MAX_DOCK_M = 46;

export interface WaterfrontResult {
  group: THREE.Group;
  /** Solid footprints (house, dock, lift) for the boat's collision, same as the marinas'. */
  dockRects: DockRect[];
  /** Hulls that should ride the swell — the ones in the water, never the one up on the lift. */
  floating: THREE.Group[];
  /**
   * Where an estate stands, so `islands.ts`'s scattered conch houses can be cleared off them.
   * `lx/lz` is the lift at the end of its dock — the far end of the whole arrangement, and the
   * only part a verification shot actually needs to aim at.
   */
  sites: Array<{ x: number; z: number; r: number; lx: number; lz: number }>;
  dispose(): void;
}

export function createWaterfront(): WaterfrontResult {
  const group = new THREE.Group();
  group.name = 'waterfront';
  const dockRects: DockRect[] = [];
  const floating: THREE.Group[] = [];
  const sites: Array<{ x: number; z: number; r: number; lx: number; lz: number }> = [];
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];

  const keep = <T extends THREE.BufferGeometry>(g: T): T => { geos.push(g); return g; };
  const M = (c: number, o: { rough?: number; metal?: number; flat?: boolean } = {}): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color: c, roughness: o.rough ?? 0.75, metalness: o.metal ?? 0, flatShading: o.flat ?? true });
    mats.push(m);
    return m;
  };

  const wood = new THREE.MeshStandardMaterial({
    color: 0x9c7a55, roughness: 0.92, flatShading: true,
    map: grainTex([2, 8], 0.75, 1.05), normalMap: normalTex([2, 8], 0.8), normalScale: new THREE.Vector2(0.5, 0.5),
  });
  mats.push(wood);
  const pileM = M(0x6e5a44, { rough: 1 });
  const railM = M(0x3a3f45, { rough: 0.5, metal: 0.4 });
  const poolM = M(0x2fa8c4, { rough: 0.12, metal: 0.1 });
  const deckM = M(0xe6e0d2, { rough: 0.9 });
  const lawnM = M(0x4e8c42, { rough: 1 });

  /** Outward normal: the gradient of the signed shore distance, which points out of the land. */
  function outward(I: Island, x: number, z: number): [number, number] {
    const d = 7;
    const gx = islandDist(I, x + d, z) - islandDist(I, x - d, z);
    const gz = islandDist(I, x, z + d) - islandDist(I, x, z - d);
    const l = Math.hypot(gx, gz);
    if (l < 1e-6) return [0, 1];
    return [gx / l, gz / l];
  }

  const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material, ry = 0): THREE.Mesh => {
    const mesh = new THREE.Mesh(keep(new THREE.BoxGeometry(w, h, d)), m);
    mesh.position.set(x, y, z); mesh.rotation.y = ry;
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  const coastal = islands.filter((I) => I.coast && !I.small && !I.miami);

  for (let ii = 0; ii < coastal.length; ii++) {
    const I = coastal[ii];
    let placed = 0;
    for (let k = 0; k < TRIES && placed < PER_ISLAND; k++) {
      const u = hashCell(WORLD_SEED, ii, k, SALT.HOUSE_ANG);
      const p = shorePoint(I, u);
      if (!p) continue;
      const [sx, sz] = p;
      const [nx, nz] = outward(I, sx, sz);

      // The house sits back from the water; the dock runs the other way.
      const hx = sx - nx * SETBACK_M, hz = sz - nz * SETBACK_M;
      if (inTownFootprint(hx, hz, 40)) continue;
      if (creekDist(hx, hz) < 30) continue;
      const l = islandLocal(I, hx, hz);
      if (onCourse(I, l[0], l[1])) continue;
      if (!I.miami && !I.mainland && Math.abs(hz - chainZ(hx)) < 20) continue;   // US-1's line
      if (landH(hx, hz) < 1.4) continue;
      if (islandDist(I, hx, hz) > -14) continue;                                  // genuinely inland

      // Does the dock reach water worth keeping a boat in?
      let reach = 0;
      for (let r = 10; r <= MAX_DOCK_M; r += 2) {
        if (depthAt(sx + nx * r, sz + nz * r) >= MIN_DOCK_DEPTH) { reach = r + 8; break; }
      }
      if (!reach || reach > MAX_DOCK_M) continue;

      if (sites.some((s) => Math.hypot(s.x - hx, s.z - hz) < SPACING_M)) continue;

      const lift = buildEstate(I, ii, k, hx, hz, nx, nz, reach);
      sites.push({ x: hx, z: hz, r: 54, lx: lift[0], lz: lift[1] });
      placed++;
    }
  }

  /** A point on this island's shoreline at walk parameter `u`, or null if it has no rings. */
  function shorePoint(I: Island, u: number): [number, number] | null {
    const rings = I.coast?.rings;
    if (!rings || !rings.length) return null;
    const ring = rings[0];
    const m = ring.length / 2;
    if (m < 3) return null;
    const f = u * m, i = Math.floor(f) % m, j = (i + 1) % m, t = f - Math.floor(f);
    return [lerp(ring[i * 2], ring[j * 2], t), lerp(ring[i * 2 + 1], ring[j * 2 + 1], t)];
  }

  function buildEstate(I: Island, ii: number, k: number, hx: number, hz: number, nx: number, nz: number, reach: number): [number, number] {
    const y = landH(hx, hz);
    // Face the water: the house's +z looks out along the outward normal.
    const yaw = Math.atan2(nx, nz);
    const style = Math.floor(hashCell(WORLD_SEED, ii, k, SALT.HOUSE_ROT) * 3);
    const tint = hashCell(WORLD_SEED, ii, k + 11, SALT.HOUSE_ROT);

    // ---- the lot: a cut lawn and a pool deck between the house and the water
    const lawn = new THREE.Mesh(keep(new THREE.BoxGeometry(44, 0.3, 54)), lawnM);
    lawn.position.set(hx + nx * 8, y - 0.1, hz + nz * 8); lawn.rotation.y = yaw;
    lawn.receiveShadow = true; group.add(lawn);

    // ---- the house
    const hw = 20, hd = 13;
    if (style === 0) {
      // Modern: two flat-roofed slabs, the upper one set back, glass to the water.
      const wallM = M(0xf2f1ec, { rough: 0.6 });
      const glassM = M(0x7fb6c9, { rough: 0.08, metal: 0.2 });
      box(hw, 3.6, hd, hx, y + 1.8, hz, wallM, yaw);
      box(hw * 0.74, 3.2, hd * 0.8, hx - nx * 1.6, y + 5.2, hz - nz * 1.6, wallM, yaw);
      box(hw * 0.92, 2.6, 0.3, hx + nx * (hd / 2 + 0.1), y + 1.9, hz + nz * (hd / 2 + 0.1), glassM, yaw);
      box(hw + 2.4, 0.3, hd + 2.4, hx, y + 3.7, hz, M(0xdedbd2, { rough: 0.8 }), yaw);
    } else if (style === 1) {
      // Key West conch mansion: two storeys, deep porches, metal roof, in a sweet colour.
      const body = [0xf6e7c8, 0xd9ecea, 0xf3d9dd, 0xe9f0d8][Math.floor(tint * 4)];
      const wallM = M(body, { rough: 0.85 });
      box(hw, 7.2, hd, hx, y + 3.6, hz, wallM, yaw);
      // Wrap-around porch, upper and lower, on posts.
      for (const [py, ph] of [[1.2, 0.2], [4.6, 0.2]] as const) {
        box(hw + 5, ph, hd + 5, hx, y + py, hz, M(0xf4f2ec, { rough: 0.8 }), yaw);
      }
      for (let i = -2; i <= 2; i++) {
        const ox = i * 5.2;
        const px = hx + Math.cos(yaw) * ox + nx * (hd / 2 + 2.2);
        const pz = hz - Math.sin(yaw) * ox + nz * (hd / 2 + 2.2);
        box(0.26, 3.3, 0.26, px, y + 2.9, pz, M(0xf4f2ec, { rough: 0.8 }));
        box(0.26, 3.3, 0.26, px, y + 6.3, pz, M(0xf4f2ec, { rough: 0.8 }));
      }
      const roof = new THREE.Mesh(keep(new THREE.ConeGeometry(hw * 0.82, 3.4, 4).rotateY(Math.PI / 4)), M(0xb8bcc2, { rough: 0.45, metal: 0.4 }));
      roof.scale.set(1, 1, hd / hw * 1.15);
      roof.position.set(hx, y + 8.9, hz); roof.rotation.y = yaw; roof.castShadow = true; group.add(roof);
    } else {
      // Mediterranean: stucco, arches, barrel tile.
      const wallM = M([0xf0e2cc, 0xeeded0, 0xf4ead9][Math.floor(tint * 3)], { rough: 0.9 });
      box(hw, 6.4, hd, hx, y + 3.2, hz, wallM, yaw);
      box(hw * 0.46, 3.4, hd * 0.6, hx - nx * 5, y + 8, hz - nz * 5, wallM, yaw);
      const tile = M(0xb4603c, { rough: 0.8 });
      const roof = new THREE.Mesh(keep(new THREE.BoxGeometry(hw + 2.2, 0.5, hd + 2.2)), tile);
      roof.position.set(hx, y + 6.6, hz); roof.rotation.y = yaw; group.add(roof);
      // Arcade along the water side.
      for (let i = -2; i <= 2; i++) {
        const ox = i * 4.4;
        const px = hx + Math.cos(yaw) * ox + nx * (hd / 2 + 1.6);
        const pz = hz - Math.sin(yaw) * ox + nz * (hd / 2 + 1.6);
        const arch = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.3, 0.3, 3.6, 8)), wallM);
        arch.position.set(px, y + 1.8, pz); group.add(arch);
      }
      box(hw * 0.9, 0.4, 3.2, hx + nx * (hd / 2 + 1.6), y + 3.7, hz + nz * (hd / 2 + 1.6), tile, yaw);
    }

    // ---- the pool, between the house and the water, with its deck
    const pxC = hx + nx * 15, pzC = hz + nz * 15;
    box(18, 0.22, 13, pxC, y + 0.12, pzC, deckM, yaw);
    const pool = new THREE.Mesh(keep(new THREE.BoxGeometry(11, 0.6, 6)), poolM);
    pool.position.set(pxC, y + 0.08, pzC); pool.rotation.y = yaw; group.add(pool);
    // Loungers, because an empty pool deck reads as a car park.
    for (const o of [-3.4, 3.4]) {
      box(0.9, 0.25, 2.1, pxC + Math.cos(yaw) * o - nx * 4.4, y + 0.42, pzC - Math.sin(yaw) * o - nz * 4.4, M(0xf4f4f2, { rough: 0.7 }), yaw);
    }

    // ---- the dock, out to water that will float a boat
    const d0 = 24;                              // where the planks start, inside the shore
    const planks = reach + d0;
    const dockW = 2.4;
    const mx = hx + nx * (d0 + planks / 2), mz = hz + nz * (d0 + planks / 2);
    box(dockW, 0.22, planks, mx, 1.05, mz, wood, yaw);
    dockRects.push({ x0: mx - planks / 2, x1: mx + planks / 2, z0: mz - planks / 2, z1: mz + planks / 2 });
    for (let s = 0; s <= planks; s += 5) {
      const px = hx + nx * (d0 + s), pz = hz + nz * (d0 + s);
      for (const o of [-dockW / 2, dockW / 2]) {
        const pil = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.17, 0.19, 5.4, 7)), pileM);
        pil.position.set(px + Math.cos(yaw) * o, -1.1, pz - Math.sin(yaw) * o); pil.castShadow = true; group.add(pil);
      }
    }

    // ---- the boat lift at the end, with something in it
    const lx = hx + nx * (d0 + planks + 1.5), lz = hz + nz * (d0 + planks + 1.5);
    const liftSide = Math.cos(yaw) * 4.2, liftSideZ = -Math.sin(yaw) * 4.2;
    const cx = lx + liftSide, cz = lz + liftSideZ;
    for (const o of [-3.4, 3.4]) {
      const bx = cx + nx * o, bz = cz + nz * o;
      for (const s of [-1.9, 1.9]) {
        const post = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.15, 0.15, 7.5, 6)), railM);
        post.position.set(bx + Math.cos(yaw) * s, 1.9, bz - Math.sin(yaw) * s); post.castShadow = true; group.add(post);
      }
      // The cradle beam the hull sits on, and the cable drum above it.
      box(4.4, 0.22, 0.22, bx, 1.55, bz, railM, yaw);
      box(4.8, 0.3, 0.3, bx, 5.3, bz, railM, yaw);
    }
    // Hoisted clear of the water — the whole point of a lift, and why she is still painted.
    const lifted = makeDockBoat(0xffffff, [0x23466e, 0x2bb3a8, 0xe4572e][Math.floor(tint * 3)]);
    lifted.position.set(cx, 1.75, cz);
    lifted.rotation.y = yaw + Math.PI / 2;
    group.add(lifted);
    dockRects.push({ x0: cx - 3.4, x1: cx + 3.4, z0: cz - 3.4, z1: cz + 3.4 });

    // ---- and often something tied off on the other side, in the water
    if (hashCell(WORLD_SEED, ii, k + 29, SALT.HOUSE_ROT) < 0.62) {
      const sxB = lx - liftSide, szB = lz - liftSideZ;
      const tied = makeSpeedboat([0xe4572e, 0x15171a, 0xf2c14e, 0x2b4a9a][Math.floor(tint * 4)]);
      tied.position.set(sxB, 0, szB);
      tied.rotation.y = yaw + Math.PI / 2;
      group.add(tied);
      floating.push(tied);
      dockRects.push({ x0: sxB - 3, x1: sxB + 3, z0: szB - 3, z1: szB + 3 });
    }
    void I;
    return [cx, cz];
  }

  /** A small go-fast: low freeboard, a wrapped windscreen and a big engine on the back. */
  function makeSpeedboat(hull: number): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(keep(new THREE.BoxGeometry(2.1, 0.95, 6.6)), M(hull, { rough: 0.25, metal: 0.15 }));
    body.position.y = 0.3; body.castShadow = true; g.add(body);
    const bow = new THREE.Mesh(keep(new THREE.ConeGeometry(1.05, 2.3, 4).rotateY(Math.PI / 4)), M(hull, { rough: 0.25, metal: 0.15 }));
    bow.rotation.x = -Math.PI / 2; bow.scale.set(1, 1, 0.45); bow.position.set(0, 0.3, -4); g.add(bow);
    g.add(deckStrip(2.0, 3.2, 0.78, -0.3));
    const screen = new THREE.Mesh(keep(new THREE.BoxGeometry(1.5, 0.5, 0.1)), M(0x9fc0cc, { rough: 0.05, metal: 0.1 }));
    screen.position.set(0, 1.05, -0.9); screen.rotation.x = -0.4; g.add(screen);
    const eng = new THREE.Mesh(keep(new THREE.BoxGeometry(0.7, 1.2, 0.8)), M(0x15171a, { rough: 0.5 }));
    eng.position.set(0, 0.5, 3.6); g.add(eng);
    return g;
  }
  function deckStrip(w: number, d: number, y: number, z: number): THREE.Mesh {
    const m = new THREE.Mesh(keep(new THREE.BoxGeometry(w, 0.1, d)), M(0xe8e4d8, { rough: 0.7 }));
    m.position.set(0, y, z);
    return m;
  }

  return {
    group,
    dockRects,
    floating,
    sites,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
