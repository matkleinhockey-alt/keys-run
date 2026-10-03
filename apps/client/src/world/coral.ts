/**
 * Coral scatter on Sombrero Reef, Coffins Patch, Delta Shoal and patch reefs in Hawk Channel.
 * Kept "as-is" per docs/ARCHITECTURE.md Phase 0 scope (a later phase redoes reef rendering as
 * chunked `InstancedMesh`-per-coral-type — see docs/ARCHITECTURE.md "Reef").
 *
 * Ported faithfully from legacy/index.html:923-937, with every `Math.random()` placement draw
 * replaced by `hashCell` keyed on each spot's own index — see world/islands.ts's doc comment for
 * why (adding/removing one spot must never reshuffle any other spot).
 */
import * as THREE from 'three';
import { hashCell } from '@keysrun/shared/rng';
import { chainZ } from '@keysrun/shared/world/chain';
import { depthAt, HUMPS } from '@keysrun/shared/world/depth';
import { floorY } from './seafloor.js';
import { grainTex } from '../core/textures.js';
import { lerp } from '../core/math.js';
import { WORLD_SEED, SALT } from '../state/constants.js';

type Spot = [number, number, number];

export function createCoral(): THREE.Group {
  const group = new THREE.Group();
  const spots: Spot[] = [];

  // main scatter along the reef wall
  for (let k = 0; k < 1400 && spots.length < 620; k++) {
    const x = lerp(-4000, 4000, hashCell(WORLD_SEED, k, 0, SALT.CORAL_MAIN_X));
    const z = chainZ(x) + lerp(1300, 1470, hashCell(WORLD_SEED, k, 0, SALT.CORAL_MAIN_Z));
    const d = depthAt(x, z);
    if (d < 13) spots.push([x, z, d]);
  }
  // the two offshore patch reefs
  HUMPS.filter((H) => H.patch).forEach((H, hi) => {
    for (let k = 0; k < 90; k++) {
      const x = H.x + lerp(-70, 70, hashCell(WORLD_SEED, hi, k, SALT.CORAL_PATCH_X));
      const z = chainZ(H.x) + H.dz + lerp(-60, 60, hashCell(WORLD_SEED, hi, k, SALT.CORAL_PATCH_Z));
      const d = depthAt(x, z);
      if (d > 1.6 && d < 13) spots.push([x, z, d]);
    }
  });
  // 10 patch-reef clusters scattered through Hawk Channel
  for (let r = 0; r < 10; r++) {
    const cx = lerp(-3800, 3800, hashCell(WORLD_SEED, r, 0, SALT.CORAL_CLUSTER_CX));
    const cz = chainZ(cx) + lerp(600, 1150, hashCell(WORLD_SEED, r, 0, SALT.CORAL_CLUSTER_CZ));
    for (let k = 0; k < 26; k++) {
      const x = cx + lerp(-20, 20, hashCell(WORLD_SEED, r, k, SALT.CORAL_CLUSTER_X));
      const z = cz + lerp(-20, 20, hashCell(WORLD_SEED, r, k, SALT.CORAL_CLUSTER_Z));
      const d = depthAt(x, z);
      if (d > 2 && d < 13) spots.push([x, z, d]);
    }
  }

  const CC = [0xc9a86b, 0xc48a4a, 0xe0b04a, 0x9fae6a, 0xd9743a, 0xb35c8a, 0x8f6fb0];
  const cm = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.9, map: grainTex([2, 2], 0.7, 1.1) }), spots.length);
  const fans = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.3, 1.5), new THREE.MeshStandardMaterial({ color: 0x9a4fae, side: THREE.DoubleSide, roughness: 1 }), spots.length);
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  spots.forEach(([x, z, d], i) => {
    const s = lerp(0.5, 1.7, hashCell(WORLD_SEED, i, 0, SALT.CORAL_SCALE));
    dummy.position.set(x, floorY(d) + s * 0.25, z);
    dummy.rotation.set(lerp(0, 1, hashCell(WORLD_SEED, i, 1, SALT.CORAL_ROT_X)), lerp(0, 6, hashCell(WORLD_SEED, i, 2, SALT.CORAL_ROT_Y)), 0);
    dummy.scale.set(
      s * lerp(0.8, 1.4, hashCell(WORLD_SEED, i, 3, SALT.CORAL_SCALE_X)),
      s * lerp(0.5, 1, hashCell(WORLD_SEED, i, 4, SALT.CORAL_SCALE_X)),
      s * lerp(0.8, 1.4, hashCell(WORLD_SEED, i, 5, SALT.CORAL_SCALE_Z)),
    );
    dummy.updateMatrix();
    cm.setMatrixAt(i, dummy.matrix);
    cm.setColorAt(i, col.setHex(CC[i % CC.length]));

    if (i % 3 === 0) {
      dummy.position.set(
        x + lerp(-2, 2, hashCell(WORLD_SEED, i, 0, SALT.CORAL_FAN_DX)),
        floorY(d) + 0.7,
        z + lerp(-2, 2, hashCell(WORLD_SEED, i, 1, SALT.CORAL_FAN_DZ)),
      );
      dummy.rotation.set(0, lerp(0, 6, hashCell(WORLD_SEED, i, 2, SALT.CORAL_FAN_ROT)), 0);
      dummy.scale.setScalar(lerp(0.7, 1.3, hashCell(WORLD_SEED, i, 3, SALT.CORAL_FAN_SCALE)));
    } else {
      dummy.scale.setScalar(0);
    }
    dummy.updateMatrix();
    fans.setMatrixAt(i, dummy.matrix);
  });
  group.add(cm, fans);
  return group;
}
