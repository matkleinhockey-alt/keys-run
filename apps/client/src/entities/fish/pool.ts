/**
 * Per-species instanced-mesh pool — legacy's `VGEO`/`VMESH`/`VFREE` (index.html:2478-2486), ported
 * and restructured around the VAT material (materials.ts) instead of the live-attribute swim
 * shader.
 *
 * One `InstancedMesh` per species, capacity `max(6, school[1]*4)` same as legacy, built once at
 * startup. `alloc()`/`free()` hand out/return instance slots; a parked (unused) instance is
 * pushed far below the world and scaled to zero exactly like legacy's `dummy.position.set(0,-50,0)
 * ... scale.setScalar(0)` placeholder. The mesh is only added to the scene while at least one
 * slot is in use, and removed once it empties back out — legacy always kept all 49 meshes in the
 * scene graph; since every species is now its own draw call (needed for per-species PBR/VAT
 * material tuning — see materials.ts), skipping the draw call entirely for a species with nothing
 * spawned keeps the "< 300 draw calls underwater" budget comfortable even though species count
 * went up from "1 shared material" to "49 materials".
 */
import * as THREE from 'three';
import type { CreatureVis } from '@keysrun/shared/content/creatures';
import { buildCreatureGeo } from './geometry.js';
import { computeSwimProfile } from './swim.js';
import { bakeVAT, attachVertexIndex, type VatBake } from './vat.js';
import { createFishMaterial } from './materials.js';

export interface SpeciesPool {
  key: string;
  V: CreatureVis;
  mesh: THREE.InstancedMesh;
  vat: VatBake;
  capacity: number;
  /** Free slot indices, highest-first (array pop/push — same access pattern as legacy's VFREE). */
  free: number[];
  inUse: number;
  group: THREE.Group;
}

const DUMMY = new THREE.Object3D();
const PARKED_Y = -50;

function parkSlot(mesh: THREE.InstancedMesh, slot: number): void {
  DUMMY.position.set(0, PARKED_Y, 0);
  DUMMY.rotation.set(0, 0, 0);
  DUMMY.scale.setScalar(0);
  DUMMY.updateMatrix();
  mesh.setMatrixAt(slot, DUMMY.matrix);
}

export function createSpeciesPool(group: THREE.Group, key: string, V: CreatureVis): SpeciesPool {
  const geo = buildCreatureGeo(key, V);
  attachVertexIndex(geo);
  const profile = computeSwimProfile(geo, key, V);
  const vat = bakeVAT(profile);
  const mat = createFishMaterial(key, V, vat, profile.uScl, profile.uShn);

  const capacity = Math.max(6, V.school[1] * 4);
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = false; // underwater draw distance is ~25m and fish are small — not worth the shadow pass
  mesh.count = 0;

  const iPhase = new Float32Array(capacity);
  mesh.geometry.setAttribute('iPhase', new THREE.InstancedBufferAttribute(iPhase, 1));

  const free: number[] = [];
  for (let i = capacity - 1; i >= 0; i--) { parkSlot(mesh, i); free.push(i); }
  mesh.instanceMatrix.needsUpdate = true;

  return { key, V, mesh, vat, capacity, free, inUse: 0, group };
}

/** Allocates one slot, or null if the pool is exhausted (legacy's `VFREE[type].length<n` guard,
 * checked by the caller before calling alloc() per-member). */
export function allocSlot(pool: SpeciesPool, swimPhase: number): number | null {
  const slot = pool.free.pop();
  if (slot === undefined) return null;
  if (pool.inUse === 0) { pool.group.add(pool.mesh); pool.mesh.count = pool.capacity; }
  pool.inUse++;
  const iPhaseAttr = pool.mesh.geometry.attributes.iPhase as THREE.InstancedBufferAttribute;
  iPhaseAttr.setX(slot, swimPhase);
  iPhaseAttr.needsUpdate = true;
  return slot;
}

export function freeSlot(pool: SpeciesPool, slot: number): void {
  parkSlot(pool.mesh, slot);
  pool.free.push(slot);
  pool.inUse--;
  if (pool.inUse <= 0) { pool.inUse = 0; pool.mesh.count = 0; pool.group.remove(pool.mesh); }
}
