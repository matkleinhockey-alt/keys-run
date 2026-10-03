/**
 * Islands and mainland terrain, with beaches and winding creeks; palms, conch houses and
 * mangroves; the Marathon airport runway.
 *
 * Ported faithfully from legacy/index.html:731-796. Miami's *skyline* (towers, port, causeways,
 * index.html:828-904) is explicitly out of Phase 0 scope (see docs/ARCHITECTURE.md) and is not
 * ported — but the Miami mainland *landform* (terrain shape/colour, including its "city" grey
 * tint) is literally part of this in-scope block and is kept, since skipping it would leave a
 * blank patch of ocean where the mainland should be.
 *
 * Seeded placement: legacy drew palms/houses/mangroves with raw `Math.random()` — an
 * iteration-order stream shared across every object in the scene, so adding one tree anywhere
 * shifts every later object's roll (see docs/ARCHITECTURE.md "Seeding"). Here each candidate's
 * position (and, for fidelity, its cosmetic height/tilt/rotation) is instead
 * `hashCell(WORLD_SEED, islandIndex, candidateIndex, salt)` — a pure function of the island and
 * that candidate's own slot, never of anything else placed before or after it. The legacy
 * rejection-sampling *shape* (try up to N candidates, keep until you have enough) is kept
 * unchanged — only the random draws inside it are now position/index-derived instead of drawn
 * from a shared stream.
 */
import * as THREE from 'three';
import { hashCell } from '@keysrun/shared/rng';
import { islands, islandWorld, type Island } from '@keysrun/shared/world/chain';
import { landH, onCourse, creekDist, CREEKS, RUNWAY } from '@keysrun/shared/world/depth';
import { lerp, rand } from '../core/math.js';
import { grainTex } from '../core/textures.js';
import { WORLD_SEED, SALT } from '../state/constants.js';

const CITY = { x0: 250, x1: 3900, zMin: -3600 };
const inCity = (x: number, z: number): boolean => x > CITY.x0 && x < CITY.x1 && z < -2560 && z > CITY.zMin;

const hash2 = (x: number, z: number): number => {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

interface Palm { x: number; z: number; y: number; h: number; lx: number; lz: number }
interface House { I: Island; x: number; z: number; y: number; r: number }
interface Mangrove { x: number; z: number; y: number; s: number }

function buildTerrain(group: THREE.Group): void {
  const landMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, map: grainTex([1, 1], 0.8, 1.08) });
  islands.forEach((I) => {
    const big = I.a > 3000, step = big ? 16 : I.a > 900 ? 8 : I.a > 200 ? 6 : 4;
    const lx0 = big ? -5600 : -I.a * 1.09, lx1 = big ? 5600 : I.a * 1.09, lz0 = -I.b * 1.09, lz1 = I.b * 1.09;
    const nx = Math.ceil((lx1 - lx0) / step), nz = Math.ceil((lz1 - lz0) / step);
    const pos: number[] = [], col: number[] = [], uv: number[] = [], hs: number[] = [], idx: number[] = [];
    for (let j = 0; j <= nz; j++) {
      for (let i = 0; i <= nx; i++) {
        const w = islandWorld(I, lx0 + i * step, lz0 + j * step), x = w[0], z = w[1];
        const h = landH(x, z), cd = creekDist(x, z), n = hash2(x * 0.13, z * 0.11);
        let c: [number, number, number];
        if (h < 0.5) c = [0.78, 0.72, 0.56];
        else if (h < 1.25) c = [0.93, 0.86, 0.66];
        else if (cd < 16 || I.small) c = [0.17 + 0.05 * n, 0.33 + 0.05 * n, 0.15];
        else if (I.mainland && inCity(x, z)) c = [0.52 + 0.06 * n, 0.53 + 0.06 * n, 0.5 + 0.05 * n];
        else c = [0.27 + 0.08 * n, 0.47 + 0.07 * n, 0.22 + 0.04 * n];
        pos.push(x, h, z); col.push(...c); uv.push(x / 14, z / 14); hs.push(h);
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
        if (Math.max(hs[a], hs[b], hs[c], hs[d]) > -1.1) idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, landMat);
    m.receiveShadow = true;
    group.add(m);
  });
}

function buildVegetation(group: THREE.Group): void {
  const dummy = new THREE.Object3D();
  const palms: Palm[] = [], houses: House[] = [], mg: Mangrove[] = [];

  islands.forEach((I, idx) => {
    const np = Math.min(340, Math.round((I.a * I.b) / 1300) + 4);
    const nh = I.name.startsWith('Bay') || I.name === 'Molasses Keys' || I.name === 'Money Key' ? 0 : Math.min(220, Math.round((I.a * I.b) / 2400) + 1);
    const nm = Math.min(140, Math.round((I.a + I.b) / 10) + 8);

    let pc = 0;
    for (let k = 0; k < np * 2 && pc < np && palms.length < 9000; k++) {
      const ang = hashCell(WORLD_SEED, idx, k, SALT.PALM_ANG) * Math.PI * 2;
      const r = Math.sqrt(hashCell(WORLD_SEED, idx, k, SALT.PALM_R)) * 0.8;
      const lx = Math.cos(ang) * r * I.a, lz = Math.sin(ang) * r * I.b;
      if (onCourse(I, lx, lz) && hashCell(WORLD_SEED, idx, k, SALT.PALM_SKIP) < 0.85) continue;
      const w = islandWorld(I, lx, lz);
      const h = landH(w[0], w[1]);
      if (h < 1.2 || (I.mainland && (Math.abs(w[0]) > 5200 || w[1] < -3900))) continue;
      if (I.mainland && inCity(w[0], w[1]) && hashCell(WORLD_SEED, idx, k, SALT.PALM_SKIP_CITY) < 0.7) continue;
      palms.push({
        x: w[0], z: w[1], y: h - 0.1,
        h: lerp(0.8, 1.3, hashCell(WORLD_SEED, idx, k, SALT.PALM_HEIGHT)),
        lx: lerp(-0.22, 0.22, hashCell(WORLD_SEED, idx, k, SALT.PALM_TILT_X)),
        lz: lerp(-0.22, 0.22, hashCell(WORLD_SEED, idx, k, SALT.PALM_TILT_Z)),
      });
      pc++;
    }

    for (let k = 0; k < nh * 3 && houses.filter((h) => h.I === I).length < nh; k++) {
      const ang = hashCell(WORLD_SEED, idx, k, SALT.HOUSE_ANG) * Math.PI * 2;
      const r = Math.sqrt(hashCell(WORLD_SEED, idx, k, SALT.HOUSE_R)) * 0.7;
      const lx = Math.cos(ang) * r * I.a, lz = Math.sin(ang) * r * I.b;
      if (onCourse(I, lx, lz) || (Math.abs(lz) < 14 && I.b > 150)) continue;
      const w = islandWorld(I, lx, lz), h = landH(w[0], w[1]);
      if (h < 1.3 || creekDist(w[0], w[1]) < 12 || I.noHouses || (I.mainland && (inCity(w[0], w[1]) || Math.abs(w[0]) > 5200 || w[1] < -3900))) continue;
      houses.push({ I, x: w[0], z: w[1], y: h, r: -I.th + (hashCell(WORLD_SEED, idx, k, SALT.HOUSE_ROT) < 0.5 ? 0 : Math.PI / 2) });
    }

    for (let k = 0; k < nm; k++) {
      const ang = hashCell(WORLD_SEED, idx, k, SALT.MANGROVE_ANG) * Math.PI * 2;
      const w = islandWorld(I, Math.cos(ang) * I.a * 0.985, Math.sin(ang) * I.b * 0.985);
      if (I.mainland && (Math.abs(w[0]) > 5200 || inCity(w[0], w[1]))) continue;
      mg.push({ x: w[0], z: w[1], y: Math.max(0.2, landH(w[0], w[1])), s: lerp(3, 6, hashCell(WORLD_SEED, idx, k, SALT.MANGROVE_SIZE)) });
    }
  });

  CREEKS.forEach((C, ci) => {
    for (let i = 0; i < C.pts.length; i += 3) {
      for (const sd of [-1, 1]) {
        const p = C.pts[i], q = C.pts[Math.min(C.pts.length - 1, i + 1)];
        const dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz) || 1;
        const x = p[0] - (dz / l) * sd * (C.w / 2 + 3), z = p[1] + (dx / l) * sd * (C.w / 2 + 3);
        const h = landH(x, z);
        if (h > 0 && !inCity(x, z)) {
          const sKey = sd < 0 ? 0 : 1;
          mg.push({ x, z, y: h, s: lerp(2.5, 5, hashCell(WORLD_SEED, ci, i * 2 + sKey, SALT.MANGROVE_CREEK_SIZE)) });
        }
      }
    }
  });

  const trunkG = new THREE.CylinderGeometry(0.16, 0.3, 7, 6).translate(0, 3.5, 0);
  const frondG = new THREE.BoxGeometry(1, 0.06, 4).translate(0, 0, 2);
  const trunks = new THREE.InstancedMesh(trunkG, new THREE.MeshStandardMaterial({ color: 0x8a6d4b, flatShading: true }), palms.length);
  const fronds = new THREE.InstancedMesh(frondG, new THREE.MeshStandardMaterial({ color: 0x3f8a35, flatShading: true, side: THREE.DoubleSide }), palms.length * 7);
  const up = new THREE.Vector3();
  let fi = 0;
  palms.forEach((p, i) => {
    dummy.position.set(p.x, p.y, p.z); dummy.rotation.set(p.lx, 0, p.lz); dummy.scale.set(1, p.h, 1); dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    up.set(0, 7 * p.h, 0).applyEuler(new THREE.Euler(p.lx, 0, p.lz));
    const tx = p.x + up.x, ty = p.y + up.y, tz = p.z + up.z;
    // Frond fan jitter is purely cosmetic sub-object detail (not placement) — left as Math.random().
    for (let k = 0; k < 7; k++) {
      dummy.position.set(tx, ty, tz);
      dummy.rotation.set(rand(0.35, 0.65), (k / 7) * Math.PI * 2 + rand(-0.2, 0.2), 0, 'YXZ');
      dummy.scale.set(1, 1, rand(0.8, 1.15));
      dummy.updateMatrix();
      fronds.setMatrixAt(fi++, dummy.matrix);
    }
  });
  trunks.castShadow = fronds.castShadow = true;
  group.add(trunks, fronds);

  const PASTEL = [0xf7c6d0, 0xfde2a7, 0xa8e0d8, 0xb9d4f5, 0xf9f3e3, 0xd8c6f0, 0xffffff, 0xc9e8c2];
  const hm = new THREE.InstancedMesh(new THREE.BoxGeometry(6, 3.4, 7), new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true }), houses.length);
  const rm = new THREE.InstancedMesh(new THREE.ConeGeometry(5.4, 2.4, 4).rotateY(Math.PI / 4), new THREE.MeshStandardMaterial({ color: 0xb8bcc2, flatShading: true, metalness: 0.3, roughness: 0.5 }), houses.length);
  const col = new THREE.Color();
  houses.forEach((h, i) => {
    dummy.position.set(h.x, h.y + 1.6, h.z); dummy.rotation.set(0, h.r, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
    hm.setMatrixAt(i, dummy.matrix);
    hm.setColorAt(i, col.setHex(PASTEL[i % PASTEL.length]));
    dummy.position.y = h.y + 4.5; dummy.scale.set(1, 1, 1.3); dummy.updateMatrix();
    rm.setMatrixAt(i, dummy.matrix);
  });
  hm.castShadow = rm.castShadow = true;
  group.add(hm, rm);

  const mm = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0x2c5a2a, flatShading: true }), mg.length);
  mg.forEach((m, i) => {
    // Tilt jitter is cosmetic only — left as Math.random(), same call site as legacy.
    dummy.position.set(m.x, m.y + 0.6, m.z); dummy.rotation.set(Math.random(), Math.random(), 0); dummy.scale.set(m.s, m.s * 0.6, m.s); dummy.updateMatrix();
    mm.setMatrixAt(i, dummy.matrix);
  });
  group.add(mm);
}

function buildRunway(group: THREE.Group): void {
  const R = RUNWAY, I = R.I;
  const g = new THREE.Group();
  g.position.set(I.x, -0.6, I.z);
  g.rotation.y = -I.th;
  group.add(g);
  const len = R.lx1 - R.lx0, cx = (R.lx0 + R.lx1) / 2;
  const rw = new THREE.Mesh(new THREE.BoxGeometry(len, 0.12, R.w), new THREE.MeshStandardMaterial({ color: 0x3b3e42, roughness: 0.95, map: grainTex([30, 2], 0.8, 1.05) }));
  rw.position.set(cx, 2.6, R.lz); rw.receiveShadow = true; g.add(rw);
  const stripeM = new THREE.MeshStandardMaterial({ color: 0xf2f2f2 });
  for (let x = R.lx0 + 20; x < R.lx1 - 20; x += 34) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(14, 0.04, 1), stripeM);
    s.position.set(x, 2.67, R.lz);
    g.add(s);
  }
  const apron = new THREE.Mesh(new THREE.BoxGeometry(160, 0.1, 60), new THREE.MeshStandardMaterial({ color: 0x6d7075, roughness: 1 }));
  apron.position.set(cx - 120, 2.59, R.lz + 55); g.add(apron);
  const term = new THREE.Mesh(new THREE.BoxGeometry(40, 7, 16), new THREE.MeshStandardMaterial({ color: 0xf3efe4, flatShading: true }));
  term.position.set(cx - 150, 6, R.lz + 80); term.castShadow = true; g.add(term);
  const plane = new THREE.Group();
  const wm = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, flatShading: true });
  const bm = new THREE.MeshStandardMaterial({ color: 0x1f4f8c, flatShading: true });
  const fus = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.6, 11, 10), wm); fus.rotation.z = Math.PI / 2; plane.add(fus);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.15, 13), wm); wing.position.set(-0.5, 0.7, 0); plane.add(wing);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.2, 0.15), bm); tail.position.set(4.8, 1.3, 0); plane.add(tail);
  const stab = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.1, 4.2), wm); stab.position.set(4.9, 0.5, 0); plane.add(stab);
  plane.position.set(cx - 100, 4.2, R.lz + 50); plane.rotation.y = 0.4; g.add(plane);
}

export function createIslands(): THREE.Group {
  const group = new THREE.Group();
  buildTerrain(group);
  buildVegetation(group);
  buildRunway(group);
  return group;
}

/** Exposed for world/bridge.ts and world/marinas.ts, which also need to skip Miami's city area. */
export { inCity };
