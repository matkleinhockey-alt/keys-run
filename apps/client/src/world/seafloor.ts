/**
 * Sea floor: sand flats, turtle grass, reef rubble fading to deep blue, plus the deep "under"
 * backstop plane.
 *
 * Ported faithfully from legacy/index.html:707-729.
 *
 * ⚠ docs/ARCHITECTURE.md flags `floorY` as a hazard to fix in a later phase (it crushes every
 * depth past 14 m to y≈-7.95 — fine for a 90k-vertex single plane, wrong for chunked LOD
 * terrain). Kept exactly as-is for Phase 0; only 6 call sites exist (here, and coral.ts).
 */
import * as THREE from 'three';
import { chainZ } from '@keysrun/shared/world/chain';
import { depthAt } from '@keysrun/shared/world/depth';
import { isTouch } from '../core/scene.js';
import { grainTex, normalTex } from '../core/textures.js';
import { clamp, lerp } from '../core/math.js';

/** legacy `floorY` (index.html:708). */
export const floorY = (d: number): number => -(0.25 + Math.min(d, 14) * 0.55);

const hash2 = (x: number, z: number): number => {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

export function createSeafloor(worldX0: number, worldZ0: number, worldSize: number): THREE.Group {
  const group = new THREE.Group();
  const touch = isTouch();
  const FSEG = touch ? 200 : 300;
  const fg = new THREE.PlaneGeometry(worldSize, worldSize, FSEG, FSEG);
  fg.rotateX(-Math.PI / 2);
  fg.translate(worldX0 + worldSize / 2, 0, worldZ0 + worldSize / 2);
  const fp = fg.attributes.position;
  const fc = new Float32Array(fp.count * 3);
  const sand: [number, number, number] = [0.93, 0.86, 0.66];
  const grass: [number, number, number] = [0.33, 0.5, 0.26];
  const rubble: [number, number, number] = [0.6, 0.5, 0.38];
  const deep: [number, number, number] = [0.04, 0.12, 0.24];
  const CORAL: Array<[number, number, number]> = [[0.55, 0.33, 0.6], [0.85, 0.55, 0.3], [0.75, 0.68, 0.42], [0.5, 0.62, 0.4]];
  const L3 = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
    [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  for (let i = 0; i < fp.count; i++) {
    const x = fp.getX(i), z = fp.getZ(i), d = depthAt(x, z), dz = z - chainZ(x);
    fp.setY(i, floorY(d));
    const n = Math.sin(x * 0.05) * Math.cos(z * 0.043) + Math.sin(x * 0.013 + z * 0.021);
    let c = L3(sand, grass, clamp(n * 0.6 + 0.4 - (d < 1 ? 0.6 : 0), 0, 1) * (dz < 0 ? 0.9 : 0.55));
    if (dz > 1250 && dz < 1650 && d < 20) {
      c = L3(c, rubble, 0.6);
      if (hash2(x, z) > 0.8) c = CORAL[Math.floor(hash2(z, x) * 4)];
    }
    c = L3(c, deep, clamp((d - 14) / 30, 0, 1));
    const j = 0.94 + hash2(x * 0.7, z * 0.3) * 0.12;
    fc[i * 3] = c[0] * j; fc[i * 3 + 1] = c[1] * j; fc[i * 3 + 2] = c[2] * j;
  }
  fg.setAttribute('color', new THREE.BufferAttribute(fc, 3));
  const floor = new THREE.Mesh(fg, new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 1, map: grainTex([700, 700], 0.8, 1.1),
    normalMap: normalTex([300, 300], 0.45), normalScale: new THREE.Vector2(0.3, 0.3),
  }));
  group.add(floor);

  const under = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0b2b4a }));
  under.position.y = -9;
  group.add(under);

  return group;
}
