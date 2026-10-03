/**
 * Clouds. Originally ported faithfully from legacy/index.html:939-946 as 60 individual `Group`s of
 * 3-6 meshes each (~270 draw calls for something that never moves or changes shape — flagged in
 * docs/ARCHITECTURE.md as a hazard: "60 cloud Groups that should be one InstancedMesh"). Rebuilt
 * here as a single `InstancedMesh`: since the clusters are static, each puff's old
 * group-then-local transform is pre-multiplied once at build time into one world matrix per
 * instance, so this draws in exactly 1 call regardless of cluster count.
 */
import * as THREE from 'three';
import { rand } from '../core/math.js';

export interface CloudsResult {
  group: THREE.Object3D;
  material: THREE.MeshStandardMaterial;
}

export function createClouds(clusterCount = 60): CloudsResult {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1, emissive: 0x8a99a6, emissiveIntensity: 0.35 });
  const geo = new THREE.IcosahedronGeometry(1, 1);

  // Puffs per cluster vary (3-6) same as legacy; size the InstancedMesh for the worst case and
  // trim `.count` down to however many we actually placed.
  const maxPuffs = clusterCount * 6;
  const mesh = new THREE.InstancedMesh(geo, material, maxPuffs);
  mesh.castShadow = false; // soft, distant, emissive-lit blobs — not worth a shadow-pass draw call
  mesh.receiveShadow = false;

  const dummy = new THREE.Object3D();
  const clusterPos = new THREE.Vector3();
  let i = 0;
  for (let c = 0; c < clusterCount; c++) {
    const n = 3 + Math.floor(Math.random() * 4);
    clusterPos.set(rand(-5500, 5500), rand(220, 340), rand(-4500, 6500));
    const clusterYaw = Math.random() * Math.PI;
    const cosY = Math.cos(clusterYaw), sinY = Math.sin(clusterYaw);
    for (let k = 0; k < n; k++) {
      const s = rand(25, 55);
      const lx = k * s * 1.1 + rand(-10, 10), ly = rand(-6, 6), lz = rand(-15, 15);
      // Apply the cluster's Y rotation to the local offset before adding the cluster position —
      // reproduces legacy's `group.rotation.y = clusterYaw; group.add(puffAtLocalXYZ)` exactly.
      dummy.position.set(clusterPos.x + lx * cosY + lz * sinY, clusterPos.y + ly, clusterPos.z - lx * sinY + lz * cosY);
      dummy.rotation.set(0, clusterYaw, 0);
      dummy.scale.set(s * 1.4, s * 0.6, s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i++, dummy.matrix);
    }
  }
  mesh.count = i;
  mesh.instanceMatrix.needsUpdate = true;

  return { group: mesh, material };
}
