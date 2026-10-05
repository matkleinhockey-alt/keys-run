/**
 * Pigeon Key set-dressing: the small historic-district island the old Seven Mile Bridge passes
 * directly beside (see docs/reference/seven-mile-bridge.jpg — the white building row, palms and
 * mown lawn tucked against the old bridge's shoulder is one of the most recognisable things in
 * that photo). The island's *landform* itself (shoreline, sand/grass terrain, a few generic
 * palms/houses) is already drawn by `world/islands.ts`'s per-island scatter (`Pigeon Key` is a
 * real entry in `@keysrun/shared/world/chain`'s `ISL_DEF`) — this module only adds the
 * recognisable extra: a tighter row of uniformly white historic buildings (not the generic
 * pastel-random houses every other island gets), more palms, and a brighter mown-lawn tint patch,
 * all placed in world space clear of both bridges' deck lines so nothing intersects.
 *
 * Deliberately owns no terrain/shoreline geometry and never touches `world/islands.ts` — this is
 * additive set dressing layered on top of it, kept inside `world/bridge/` (this task's scope) and
 * merged into `createBridge()`'s returned group.
 */
import * as THREE from 'three';
import { chainZ } from '@keysrun/shared/world/chain';
import { landH } from '@keysrun/shared/world/depth';
import { grainTex, normalTex } from '../../core/textures.js';

const KEY_X = -2650;
const KEY_BASE_Z = chainZ(KEY_X) - 62; // matches the island's own ISL_DEF offset in chain.ts

// Hand-placed (not random-scattered — this is one specific named landmark, not a generic
// island): a loose row along the key's south-central ground, clear of the old bridge (world dz
// -58, i.e. ~16+ units north of this cluster) and the new bridge (dz 0, ~15+ units south of it).
interface BuildingSpec { dx: number; dz: number; w: number; d: number; h: number; rot: number }
const BUILDINGS: BuildingSpec[] = [
  { dx: -44, dz: -27, w: 7.5, d: 6, h: 3.6, rot: 0.08 },
  { dx: -28, dz: -34, w: 6.5, d: 5.5, h: 3.3, rot: -0.22 },
  { dx: -11, dz: -21, w: 10, d: 6.5, h: 4.1, rot: 0.04 }, // the long "cafeteria/machine shop" building
  { dx: 7, dz: -31, w: 6.5, d: 5.5, h: 3.3, rot: 0.18 },
  { dx: 22, dz: -19, w: 6, d: 5.5, h: 3.4, rot: -0.1 },
  { dx: 36, dz: -33, w: 7, d: 5.5, h: 3.5, rot: 0.24 },
  { dx: 48, dz: -23, w: 5.5, d: 5, h: 3.1, rot: -0.06 },
];

interface PalmSpec { dx: number; dz: number; h: number; tilt: number }
const PALMS: PalmSpec[] = [
  { dx: -50, dz: -18, h: 1.1, tilt: 0.15 }, { dx: -36, dz: -14, h: 0.95, tilt: -0.1 },
  { dx: -20, dz: -40, h: 1.2, tilt: 0.05 }, { dx: -4, dz: -12, h: 1, tilt: -0.18 },
  { dx: 2, dz: -39, h: 1.05, tilt: 0.12 }, { dx: 14, dz: -11, h: 0.9, tilt: -0.08 },
  { dx: 29, dz: -41, h: 1.15, tilt: 0.2 }, { dx: 41, dz: -13, h: 1, tilt: -0.14 },
  { dx: 54, dz: -30, h: 0.95, tilt: 0.1 }, { dx: -56, dz: -36, h: 1.05, tilt: -0.05 },
];

export function createPigeonKey(): THREE.Group {
  const group = new THREE.Group();
  const dummy = new THREE.Object3D();

  // Mown lawn: a brighter tint patch over the ground the generic island terrain (world/islands.ts)
  // already drew a uniform dark mangrove-green for every "small" island — Pigeon Key alone reads
  // as actually maintained grounds. Height-matched to landH + a hair of lift to avoid z-fighting.
  {
    const w = 130, d = 70;
    const cx = KEY_X - 1, cz = KEY_BASE_Z - 26;
    const g = new THREE.PlaneGeometry(w, d, 24, 14);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + cx, z = pos.getZ(i) + cz;
      pos.setY(i, Math.max(landH(x, z), 1.15) + 0.04);
    }
    g.translate(cx, 0, cz);
    g.computeVertexNormals();
    const lawn = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      color: 0x4f9a3f, roughness: 0.95, map: grainTex([20, 12], 0.85, 1.05),
      normalMap: normalTex([20, 12], 0.4), normalScale: new THREE.Vector2(0.3, 0.3),
    }));
    lawn.receiveShadow = true;
    group.add(lawn);
  }

  // Buildings: uniformly white clapboard walls, pale tin-gray gabled roofs — distinct from
  // islands.ts's random-pastel generic houses, matching the reference photo's historic row.
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf5f2e6, flatShading: true, roughness: 0.85, map: grainTex([2, 1], 0.9, 1.05) });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xaab0b6, flatShading: true, roughness: 0.55, metalness: 0.25 });
  const wallGeo = new THREE.BoxGeometry(1, 1, 1);
  const roofGeo = new THREE.ConeGeometry(0.72, 1, 4).rotateY(Math.PI / 4);
  const walls = new THREE.InstancedMesh(wallGeo, wallMat, BUILDINGS.length);
  const roofs = new THREE.InstancedMesh(roofGeo, roofMat, BUILDINGS.length);
  BUILDINGS.forEach((b, i) => {
    const x = KEY_X + b.dx, z = KEY_BASE_Z + b.dz, y = Math.max(landH(x, z), 1.2);
    dummy.position.set(x, y + b.h / 2, z); dummy.rotation.set(0, b.rot, 0); dummy.scale.set(b.w, b.h, b.d); dummy.updateMatrix();
    walls.setMatrixAt(i, dummy.matrix);
    dummy.position.set(x, y + b.h + 0.6, z); dummy.rotation.set(0, b.rot, 0); dummy.scale.set(b.w * 0.95, 1.2, b.d * 1.25); dummy.updateMatrix();
    roofs.setMatrixAt(i, dummy.matrix);
  });
  walls.castShadow = walls.receiveShadow = true;
  roofs.castShadow = true;
  group.add(walls, roofs);

  // Palms: same trunk+frond construction world/islands.ts uses for the rest of the Keys, kept
  // local to this module (no cross-file coupling) and static (no wind shader) — a dozen trees is
  // cheap either way and this is a one-off landmark, not a density system.
  const trunkGeo = new THREE.CylinderGeometry(0.15, 0.28, 6.4, 6).translate(0, 3.2, 0);
  const frondGeo = new THREE.BoxGeometry(0.9, 0.05, 3.6).translate(0, 0, 1.8);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8a6d4b, flatShading: true });
  const frondMat = new THREE.MeshStandardMaterial({ color: 0x3f8a35, flatShading: true, side: THREE.DoubleSide });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, PALMS.length);
  const fronds = new THREE.InstancedMesh(frondGeo, frondMat, PALMS.length * 6);
  let fi = 0;
  const up = new THREE.Vector3();
  PALMS.forEach((p, i) => {
    const x = KEY_X + p.dx, z = KEY_BASE_Z + p.dz, y = Math.max(landH(x, z), 1.1);
    dummy.position.set(x, y, z); dummy.rotation.set(p.tilt, 0, p.tilt * 0.6); dummy.scale.set(1, p.h, 1); dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    up.set(0, 6.4 * p.h, 0).applyEuler(new THREE.Euler(p.tilt, 0, p.tilt * 0.6));
    const tx = x + up.x, ty = y + up.y, tz = z + up.z;
    for (let k = 0; k < 6; k++) {
      dummy.position.set(tx, ty, tz);
      dummy.rotation.set(0.5, (k / 6) * Math.PI * 2, 0, 'YXZ');
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      fronds.setMatrixAt(fi++, dummy.matrix);
    }
  });
  trunks.castShadow = fronds.castShadow = true;
  group.add(trunks, fronds);

  return group;
}
