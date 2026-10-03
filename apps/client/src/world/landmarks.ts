/**
 * Sombrero Key Light, Faro Blanco Marina's tower, and the reef mooring-ball line along Hawk
 * Channel.
 *
 * Ported faithfully from legacy/index.html:906-922. Mooring-ball positions used raw
 * `Math.random()` in legacy; converted to `hashCell` keyed by the ball's own grid slot — see
 * docs/ARCHITECTURE.md "Seeding" and world/islands.ts's doc comment for the general approach.
 */
import * as THREE from 'three';
import { hashCell } from '@keysrun/shared/rng';
import { chainZ } from '@keysrun/shared/world/chain';
import { MARINAS } from '@keysrun/shared/world/depth';
import { WORLD_SEED, SALT } from '../state/constants.js';
import { lerp } from '../core/math.js';

export function createLandmarks(): THREE.Group {
  const group = new THREE.Group();

  const lx = 250, lz = chainZ(250) + 1420;
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 6, 42, 8, 10, true), new THREE.MeshBasicMaterial({ color: 0x7a5a3a, wireframe: true }));
  tower.position.set(lx, 20, lz); group.add(tower);
  const house = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 3.4, 8), new THREE.MeshStandardMaterial({ color: 0x2b2f33 }));
  house.position.set(lx, 42, lz); group.add(house);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.2, 10, 8), new THREE.MeshBasicMaterial({ color: 0xfff1a6 }));
  lamp.position.set(lx, 44.5, lz); group.add(lamp);
  const plat = new THREE.Mesh(new THREE.BoxGeometry(14, 1, 14), new THREE.MeshStandardMaterial({ color: 0x5b4a43 }));
  plat.position.set(lx, 6, lz); group.add(plat);

  const fb = MARINAS.find((m) => m.name === 'Faro Blanco Marina');
  if (fb) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.2, 12, 10), new THREE.MeshStandardMaterial({ color: 0xf4f4f2 }));
    t.position.set(fb.sx - 24, 8, fb.sz - fb.dir * 6); group.add(t);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 1.8, 2.2, 10), new THREE.MeshStandardMaterial({ color: 0xc8302e }));
    cap.position.set(fb.sx - 24, 15, fb.sz - fb.dir * 6); group.add(cap);
  }

  const balls: Array<[number, number]> = [];
  let bi = 0;
  for (let x = -3900; x < 3900; x += 260) {
    balls.push([
      x + lerp(-30, 30, hashCell(WORLD_SEED, bi, 0, SALT.MOORING_REEF_X)),
      chainZ(x) + lerp(1360, 1440, hashCell(WORLD_SEED, bi, 0, SALT.MOORING_REEF_Z)),
    ]);
    bi++;
  }
  const dummy = new THREE.Object3D();
  const bm = new THREE.InstancedMesh(new THREE.SphereGeometry(0.55, 10, 8), new THREE.MeshStandardMaterial({ color: 0xffffff }), balls.length);
  balls.forEach((b, i) => {
    dummy.position.set(b[0], 0.25, b[1]); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
    bm.setMatrixAt(i, dummy.matrix);
  });
  group.add(bm);

  return group;
}
