/**
 * Clouds. Ported faithfully from legacy/index.html:939-946.
 *
 * ⚠ docs/ARCHITECTURE.md flags the 60 individual `Group`s here as a hazard ("~270 needless draw
 * calls") a later phase should merge into one `InstancedMesh`. Kept as-is for Phase 0.
 */
import * as THREE from 'three';
import { rand } from '../core/math.js';

export interface CloudsResult {
  group: THREE.Group;
  material: THREE.MeshStandardMaterial;
}

export function createClouds(): CloudsResult {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1, emissive: 0x8a99a6, emissiveIntensity: 0.35 });
  const cg = new THREE.IcosahedronGeometry(1, 1);
  for (let i = 0; i < 60; i++) {
    const g = new THREE.Group();
    const n = 3 + Math.floor(Math.random() * 4);
    for (let k = 0; k < n; k++) {
      const m = new THREE.Mesh(cg, material);
      const s = rand(25, 55);
      m.scale.set(s * 1.4, s * 0.6, s);
      m.position.set(k * s * 1.1 + rand(-10, 10), rand(-6, 6), rand(-15, 15));
      g.add(m);
    }
    g.position.set(rand(-5500, 5500), rand(220, 340), rand(-4500, 6500));
    g.rotation.y = Math.random() * Math.PI;
    group.add(g);
  }
  return { group, material };
}
