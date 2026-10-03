/**
 * `renderSchool(state, pool)` — the three.js half of the school.ts/render.ts split described in
 * docs/ARCHITECTURE.md's fish-ownership note. Reads the plain `wx/wy/wz/yaw/pitch/roll/worldScale`
 * numbers `stepSchool` wrote onto each member and turns them into one `InstancedMesh` matrix
 * write per member (legacy's `dummy.position.set/rotation.set/scale.setScalar/updateMatrix` +
 * `mesh.setMatrixAt`, index.html:2595-2596) — the one place in the whole fish system that touches
 * three.js on the per-member hot path.
 */
import * as THREE from 'three';
import type { SchoolState } from './types.js';
import type { SpeciesPool } from './pool.js';

const dummy = new THREE.Object3D();

export function renderSchool(state: SchoolState, pool: SpeciesPool): void {
  for (const m of state.members) {
    dummy.position.set(m.wx, m.wy, m.wz);
    dummy.rotation.set(m.pitch, m.yaw, m.roll, 'YXZ');
    dummy.scale.setScalar(m.worldScale);
    dummy.updateMatrix();
    pool.mesh.setMatrixAt(m.slot, dummy.matrix);
  }
}

/** Call once per frame after every active school has been stepped+rendered this frame. */
export function finalizePoolRender(pool: SpeciesPool): void {
  if (pool.inUse > 0) pool.mesh.instanceMatrix.needsUpdate = true;
}
