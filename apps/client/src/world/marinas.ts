/**
 * Marinas, Boot Key Harbor mooring field, and the two golf courses.
 *
 * Ported faithfully from legacy/index.html:1655-1739. `dockCollide` itself is NOT here — its
 * math is ported into the pure `stepBoat` (packages/shared/src/sim/boat.ts); this module only
 * builds the `DOCK_RECTS` collision geometry it needs, plus the visible docks/boats/golf
 * courses.
 *
 * Seeded placement: the dock/mooring piers and pilings are already fully deterministic in
 * legacy (stepped directly from each marina's `sx`/`sz`, no `Math.random()`). The Boot Key
 * Harbor sailboat mooring field *does* use `Math.random()` in legacy and is converted to
 * `hashCell` here — see world/islands.ts's doc comment for the general approach.
 */
import * as THREE from 'three';
import { hashCell } from '@keysrun/shared/rng';
import { chainZ, shoreInfo } from '@keysrun/shared/world/chain';
import { depthAt, MARINAS, GOLF, type Marina } from '@keysrun/shared/world/depth';
import { HULLS } from '@keysrun/shared/content/boats';
import type { DockRect } from '@keysrun/shared/sim/boat';
import { buildHullGeo } from '../entities/boat/hull.js';
import { grainTex } from '../core/textures.js';
import { lerp } from '../core/math.js';
import { WORLD_SEED, SALT, SPAWN_X, SPAWN_DZ } from '../state/constants.js';

function makeDockBoat(hull: number, top: number): THREE.Group {
  const H = { ...HULLS.robalo, colors: { ...HULLS.robalo.colors, hull, boot: top, cove: null } };
  const g = new THREE.Group();
  const L = 7.4, B = 2.6;
  g.add(new THREE.Mesh(buildHullGeo(H, L, B, { deck: true }), new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.3, side: THREE.DoubleSide })));
  const M = (c: number) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.5 });
  const con = new THREE.Mesh(new THREE.BoxGeometry(1, 1.1, 1), M(0xf2f2f2));
  con.position.set(0, 0.95, 0.2); g.add(con);
  const tt = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.08, 2.2), M(top));
  tt.position.set(0, 2.75, 0.3); g.add(tt);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.2, 6), M(0xd9dde2));
    p.position.set(sx * 0.7, 1.65, 0.3 + sz * 0.8); g.add(p);
  }
  const ob = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.1, 0.7), M(0x15171a));
  ob.position.set(0, 0.8, L / 2 + 0.4); g.add(ob);
  return g;
}

function makeSailboat(hull: number): THREE.Group {
  const H = { ...HULLS.grady, F: 1.1, spring: 0.25, dr0: 16, dr1: 40, rake: 1.2, colors: { ...HULLS.grady.colors, hull, boot: 0x23466e, cove: null, deck: 0xd8cdb5 } };
  const g = new THREE.Group();
  const L = 10, B = 3.2;
  g.add(new THREE.Mesh(buildHullGeo(H, L, B, { deck: true }), new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.35, side: THREE.DoubleSide })));
  const M = (c: number) => new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.5 });
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2, 0.7, 3.4), M(0xf4f4f2));
  cab.position.set(0, 1.3, -0.4); g.add(cab);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 13, 6), M(0xd9dde2));
  mast.position.set(0, 7.6, -1.4); g.add(mast);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 4, 6), M(0xd9dde2));
  boom.rotation.x = Math.PI / 2; boom.position.set(0, 2.3, 0.6); g.add(boom);
  const cover = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 3.8), M(0x1f4f8c));
  cover.position.set(0, 2.55, 0.6); g.add(cover);
  return g;
}

export interface MarinasResult {
  group: THREE.Group;
  dockRects: DockRect[];
  /** Decorative moored boats, bobbed on the waves each frame in game/world.ts, same as legacy. */
  dockBoats: THREE.Group[];
}

export function createMarinas(): MarinasResult {
  const group = new THREE.Group();
  const dummy = new THREE.Object3D();
  const DOCK_RECTS: DockRect[] = [];
  const dockBoats: THREE.Group[] = [];

  const wood = new THREE.MeshStandardMaterial({ color: 0x9c7a55, roughness: 0.9, flatShading: true, map: grainTex([2, 8], 0.75, 1.05) });
  const pile = new THREE.MeshStandardMaterial({ color: 0x6e5a44, roughness: 1 });
  const piles: Array<[number, number]> = [];
  const addBox = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, collide: boolean): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = m.receiveShadow = true;
    group.add(m);
    if (collide) DOCK_RECTS.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 });
    return m;
  };
  const BOATC: Array<[number, number]> = [[0xffffff, 0x23466e], [0xf3efe5, 0x2bb3a8], [0xe8eef2, 0xe4572e], [0xffffff, 0x14181f]];

  MARINAS.forEach((M: Marina, mi: number) => {
    const { sx, sz, dir } = M;
    const Z = (o: number) => sz + dir * o;
    addBox(3, 0.35, 56, sx, 1.25, Z(20), wood, true);
    addBox(26, 0.35, 3, sx, 1.25, Z(48), wood, true);
    for (let o = -6; o <= 48; o += 6) { piles.push([sx - 1.6, Z(o)], [sx + 1.6, Z(o)]); }
    for (let x = -12; x <= 12; x += 6) piles.push([sx + x, Z(49.6)]);
    ([14, 26, 38] as const).forEach((o) => {
      for (const s of [-1, 1]) {
        addBox(10, 0.3, 1.4, sx + s * 6.5, 1.2, Z(o), wood, true);
        piles.push([sx + s * 11.4, Z(o)]);
      }
    });
    ([[-1, 20], [1, 20], [-1, 32], [1, 32]] as const).forEach(([s, o], k) => {
      if ((k + mi) % 4 === 3) return;
      const c = BOATC[(k + mi) % 4], b = makeDockBoat(c[0], c[1]);
      b.position.set(sx + s * 6.8, 0, Z(o));
      b.rotation.y = dir > 0 ? Math.PI : 0;
      group.add(b);
      dockBoats.push(b);
      DOCK_RECTS.push({ x0: sx + s * 6.8 - 1.4, x1: sx + s * 6.8 + 1.4, z0: Z(o) - 3.8, z1: Z(o) + 3.8 });
    });
    addBox(11, 4, 7, sx + 13, 2.8, Z(-9), new THREE.MeshStandardMaterial({ color: [0xa8e0d8, 0xfde2a7, 0xf7c6d0, 0xb9d4f5][mi], flatShading: true }), false);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(7.4, 2.4, 4).rotateY(Math.PI / 4), new THREE.MeshStandardMaterial({ color: 0xb8bcc2, flatShading: true, metalness: 0.3 }));
    roof.scale.set(1, 1, 0.7); roof.position.set(sx + 13, 6, Z(-9)); group.add(roof);
    const scale = new THREE.Mesh(new THREE.BoxGeometry(0.25, 4, 0.25), pile);
    scale.position.set(sx + 2.2, 3.2, Z(46.5)); group.add(scale);
    const bar = new THREE.Mesh(new THREE.BoxGeometry(3, 0.2, 0.2), pile);
    bar.position.set(sx + 3.2, 5.1, Z(46.5)); group.add(bar);
  });

  const pm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.22, 4.4, 7), pile, piles.length);
  piles.forEach((p, i) => {
    dummy.position.set(p[0], 0.2, p[1]); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
    pm.setMatrixAt(i, dummy.matrix);
  });
  group.add(pm);

  // Boot Key Harbor mooring field: sailboats swinging on their balls
  const SAILC = [0xffffff, 0xf3efe5, 0xe8eef2, 0x1f4f8c, 0xf6f1e4];
  let placed = 0;
  for (let k = 0; k < 400 && placed < 22; k++) {
    const x = lerp(-1650, -500, hashCell(WORLD_SEED, k, 0, SALT.MOORING_HARBOR_X));
    const z = chainZ(x) + lerp(240, 420, hashCell(WORLD_SEED, k, 0, SALT.MOORING_HARBOR_Z));
    if (
      depthAt(x, z) < 3 || shoreInfo(x, z).d < 20
      || MARINAS.some((M) => Math.hypot(x - M.sx, z - M.ez) < 45)
      || Math.hypot(x - SPAWN_X, z - (chainZ(SPAWN_X) + SPAWN_DZ)) < 80
      || DOCK_RECTS.some((r) => Math.hypot(x - (r.x0 + r.x1) / 2, z - (r.z0 + r.z1) / 2) < 14)
    ) continue;
    const b = makeSailboat(SAILC[placed % SAILC.length]);
    b.position.set(x, 0, z);
    b.rotation.y = 0.4 + lerp(-0.25, 0.25, hashCell(WORLD_SEED, k, 0, SALT.MOORING_HARBOR_ROT));
    group.add(b);
    dockBoats.push(b);
    DOCK_RECTS.push({ x0: x - 2.2, x1: x + 2.2, z0: z - 4.6, z1: z + 4.6 });
    placed++;
  }

  // golf: Sombrero Country Club and the Key Colony Beach par-3
  GOLF.forEach((G) => {
    const I = G.I, gg = new THREE.Group();
    gg.position.set(I.x, -0.6, I.z); gg.rotation.y = -I.th; group.add(gg);
    const flat = (rx: number, rz: number, lx: number, lz: number, y: number, color: number, tex?: THREE.Texture): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color, roughness: 1, map: tex || null }));
      m.scale.set(rx, 1, rz); m.position.set(lx, y, lz); m.receiveShadow = true; gg.add(m);
      return m;
    };
    flat(G.ra, G.rb, G.lx, G.lz, 2.55, 0x5aa548, grainTex([30, 30], 0.85, 1.05));
    for (let h = 0; h < G.holes; h++) {
      const f = G.holes === 1 ? 0 : (h / (G.holes - 1) - 0.5) * 1.3, lz = G.lz + f * G.rb * 0.62, cx = G.lx + [-0.08, 0.1, -0.04, 0.06][h % 4] * G.ra, rx = G.ra * 0.42;
      flat(rx, G.rb * 0.1, cx, lz, 2.57, 0x7cc35a, grainTex([20, 2], 0.9, 1.04));
      const gx = cx + rx * 0.84;
      flat(7, 7, gx, lz, 2.58, 0x9be07a);
      const tee = new THREE.Mesh(new THREE.BoxGeometry(5, 0.12, 4), new THREE.MeshStandardMaterial({ color: 0x8fd56a }));
      tee.position.set(cx - rx * 0.85, 2.6, lz); gg.add(tee);
      flat(4.5, 2.4, gx - 8, lz + 5, 2.585, 0xe9d9a6);
      flat(3.4, 2.1, gx + 6, lz - 5, 2.585, 0xe9d9a6);
      const poleM = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.3, 6), new THREE.MeshStandardMaterial({ color: 0xffffff }));
      poleM.position.set(gx, 3.7, lz); gg.add(poleM);
      const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.6), new THREE.MeshStandardMaterial({ color: 0xe4572e, side: THREE.DoubleSide }));
      flag.position.set(gx + 0.45, 4.55, lz); gg.add(flag);
      if (h === 1) flat(G.ra * 0.1, G.rb * 0.08, cx - rx * 0.2, lz + G.rb * 0.14, 2.586, 0x3fa7c9);
      const cart = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1, 2.2), new THREE.MeshStandardMaterial({ color: 0xf4f4f2, flatShading: true }));
      cart.position.set(cx - rx * 0.4, 3.05, lz + G.rb * 0.08); gg.add(cart);
    }
    const club = new THREE.Mesh(new THREE.BoxGeometry(18, 5, 11), new THREE.MeshStandardMaterial({ color: 0xf6f1e4, flatShading: true }));
    club.position.set(G.lx + G.ra * 0.72, 5.05, G.lz + G.rb * 0.7); club.castShadow = true; gg.add(club);
    const cr = new THREE.Mesh(new THREE.ConeGeometry(12, 3, 4).rotateY(Math.PI / 4), new THREE.MeshStandardMaterial({ color: 0xc8643c, flatShading: true }));
    cr.scale.set(1, 1, 0.65); cr.position.set(G.lx + G.ra * 0.72, 9, G.lz + G.rb * 0.7); gg.add(cr);
  });

  return { group, dockRects: DOCK_RECTS, dockBoats };
}
