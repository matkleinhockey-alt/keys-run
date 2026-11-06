/**
 * Clouds. Originally ported faithfully from legacy/index.html:939-946 as 60 individual `Group`s of
 * 3-6 meshes each (~270 draw calls for something that never moves or changes shape — flagged in
 * docs/ARCHITECTURE.md as a hazard: "60 cloud Groups that should be one InstancedMesh"). Rebuilt
 * as a single `InstancedMesh`, and it is still exactly one draw call however many puffs it holds.
 *
 * WHAT MAKES THEM READ AS CLOUDS. The instancing was right; the shape was not. Each cluster laid
 * its puffs in a straight line (`lx = k * s * 1.1`), so every cloud was a caterpillar of blobs in
 * a row, each one squashed to 0.6 of its width, hung at a random height between 220 and 340 m.
 * Three things fix that, and all of them are how fair-weather cumulus actually work:
 *
 *  - **A flat base.** Cumulus condense at one altitude, so over any stretch of water their bases
 *    line up at the same height while their tops do not. That shared waterline under a sky full
 *    of clouds is most of what makes them look like weather rather than scenery.
 *  - **Vertical build.** Puffs are stacked into a dome — broad and crowded at the base, fewer and
 *    smaller toward the top, the dome higher in the middle of the cluster than at its edges.
 *  - **A dark base.** A cumulus is lit from above and shades itself underneath. Per-instance
 *    colour carries that: the lowest puffs are grey, the top ones white. It multiplies the shared
 *    material, so the day/night tint (`tod.setCloudMat`) still drives all of them as before.
 *
 * They also drift now, which is the other half of "weather". The whole field moves on the wind
 * and each puff wraps around the field rather than the field sliding off the map, so it never
 * jumps. The matrices are rewritten at 4 Hz, not per frame: at a metre or two a second nobody can
 * see the difference and it keeps the upload off the frame budget.
 */
import * as THREE from 'three';
import { rand } from '../core/math.js';

export interface CloudsResult {
  group: THREE.Object3D;
  material: THREE.MeshStandardMaterial;
  /** Drifts the field on the wind. Safe to call every frame; rewrites matrices at 4 Hz. */
  update(dt: number): void;
}

/**
 * Condensation level: every cloud base sits here, give or take a little.
 *
 * 740 m, not the 235 m this inherited. Fair-weather cumulus over the Keys sit around 2,400 ft,
 * and the difference is not pedantry: at 235 m a cloud is only a couple of degrees above the
 * horizon from a boat, so the sky directly overhead was always empty and the whole field read as
 * a band of haze sitting on the sea. Cluster sizes scale with it — a real cumulus is hundreds of
 * metres across, and shrinking them to match the old altitude is what made them puffs of smoke.
 * The camera's far plane is 9,000, so there is room.
 */
const BASE_Y = 740;
/** Half-width of the field in x and z. Puffs wrap within it so the sky never empties. */
const SPREAD_X = 5500, SPREAD_Z = 5500, FIELD_Z0 = 1000;
/** Wind. Slow enough to be weather rather than a conveyor belt. */
const DRIFT_X = 1.6, DRIFT_Z = 0.55;
const REWRITE_HZ = 4;

export function createClouds(clusterCount = 60): CloudsResult {
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 1, emissive: 0x8a99a6, emissiveIntensity: 0.35 });
  const geo = new THREE.IcosahedronGeometry(1, 1);

  const maxPuffs = clusterCount * 12;
  const mesh = new THREE.InstancedMesh(geo, material, maxPuffs);
  mesh.castShadow = false; // soft, distant, emissive-lit blobs — not worth a shadow-pass draw call
  mesh.receiveShadow = false;
  mesh.frustumCulled = false; // one object spanning the whole sky: its bounds are never off screen

  // Per-puff rest state, so drift can be applied without re-deriving the cluster layout.
  const px: number[] = [], py: number[] = [], pz: number[] = [];
  const sx: number[] = [], sy: number[] = [], sz: number[] = [], ry: number[] = [];

  const col = new THREE.Color();
  let i = 0;
  for (let c = 0; c < clusterCount && i < maxPuffs; c++) {
    const cx = rand(-SPREAD_X, SPREAD_X), cz = FIELD_Z0 + rand(-SPREAD_Z, SPREAD_Z);
    const base = BASE_Y + rand(-14, 14);
    const R = rand(95, 250);           // cluster half-width, metres
    const dome = R * rand(0.45, 0.95); // how far it builds above its base
    const n = 6 + Math.floor(Math.random() * 7);
    for (let k = 0; k < n && i < maxPuffs; k++) {
      // Position in a disc, then lift by how near the middle it is — a dome, not a row.
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * R;
      const centreness = Math.pow(1 - rr / R, 0.8);
      const h = Math.random() * dome * centreness;
      // Puffs thin out as they climb; the base course is the fattest.
      const s = (R * 0.42) * (0.55 + 0.45 * (1 - h / Math.max(1, dome))) * rand(0.78, 1.18);
      px.push(cx + Math.cos(a) * rr);
      py.push(base + h + s * 0.32);    // sit the puff ON the base rather than through it
      pz.push(cz + Math.sin(a) * rr);
      sx.push(s * 1.25); sy.push(s * 0.82); sz.push(s * 1.1);
      ry.push(Math.random() * Math.PI);
      // Shaded underside: grey at the base, white at the top of the dome.
      const lift = Math.min(1, h / Math.max(1, dome));
      col.setRGB(0.70 + 0.30 * lift, 0.73 + 0.27 * lift, 0.78 + 0.22 * lift);
      mesh.setColorAt(i, col);
      i++;
    }
  }
  mesh.count = i;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  const dummy = new THREE.Object3D();
  let driftX = 0, driftZ = 0, acc = 0;
  const span = SPREAD_X * 2, spanZ = SPREAD_Z * 2;
  const write = (): void => {
    for (let k = 0; k < i; k++) {
      // Wrap each puff inside the field, so the sky stays full and nothing ever jumps.
      let x = px[k] + driftX, z = pz[k] + driftZ;
      x = ((x + SPREAD_X) % span + span) % span - SPREAD_X;
      z = ((z - FIELD_Z0 + SPREAD_Z) % spanZ + spanZ) % spanZ - SPREAD_Z + FIELD_Z0;
      dummy.position.set(x, py[k], z);
      dummy.rotation.set(0, ry[k], 0);
      dummy.scale.set(sx[k], sy[k], sz[k]);
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  write();

  return {
    group: mesh,
    material,
    update(dt: number): void {
      if (!Number.isFinite(dt) || dt <= 0) return;
      driftX += DRIFT_X * dt; driftZ += DRIFT_Z * dt;
      acc += dt;
      if (acc < 1 / REWRITE_HZ) return;
      acc = 0;
      write();
    },
  };
}
