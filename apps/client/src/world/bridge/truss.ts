/**
 * The old bridge's steel through-truss section, just west of Pigeon Key (see
 * docs/reference/seven-mile-bridge.jpg's header note and this project's task brief: "It carries a
 * steel truss section near Pigeon Key"). The historic Knight's Key–Pigeon Key–Moser Channel
 * bridge carried one distinctive riveted-steel truss span amid otherwise-concrete construction;
 * this is a single hand-placed landmark (like `world/landmarks.ts`'s Sombrero Light), not a
 * repeating system, so its 3 bays are fixed world coordinates rather than scattered/seeded.
 *
 * Every member (chords, verticals, diagonals, top lateral bracing) is one instance in a single
 * `InstancedMesh` of a unit box, positioned/rotated per member via the same
 * midpoint+quaternion-alignment trick `entities/boat/hull.ts`'s `beamBetween`/`panelBetween` use
 * (reimplemented locally — this module intentionally has no dependency on entities/boat/**, which
 * is out of scope here) — one draw call for the whole structure regardless of bay count.
 */
import * as THREE from 'three';
import { chainZ } from '@keysrun/shared/world/chain';
import { OLDBR } from '@keysrun/shared/world/depth';

// Fixed span, chosen from the real deck-segment grid just west of Pigeon Key's own landmass
// (world/bridge.ts's STEP=24 lattice) — see this module's report for how that location was found.
const TRUSS_X0 = -2812;
const TRUSS_BAYS = 3;
const BAY = 24;
const HALF_W = 3.95;
const TRUSS_H = 5.2;
const MEMBER = 0.26;

const dz = (x: number): number => chainZ(x) + OLDBR.dz;

interface V3 { x: number; y: number; z: number }

function addBeam(mesh: THREE.InstancedMesh, dummy: THREE.Object3D, idx: number, p1: V3, p2: V3, w: number, th: number): void {
  const dx = p2.x - p1.x, dy = p2.y - p1.y, dzz = p2.z - p1.z, len = Math.hypot(dx, dy, dzz);
  dummy.position.set((p1.x + p2.x) / 2, (p1.y + p2.y) / 2, (p1.z + p2.z) / 2);
  dummy.scale.set(w, len, th);
  dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, dy, dzz).normalize());
  dummy.updateMatrix();
  mesh.setMatrixAt(idx, dummy.matrix);
}

/** `deckH` is the old bridge's own deck-top height (world/bridge.ts's constant) so the truss's
 * bottom chord sits flush with the real deck it's built over. */
export function buildOldBridgeTruss(deckH: number): THREE.Group {
  const group = new THREE.Group();

  // Boundary points (4, bounding 3 bays), each carrying both rail sides at both chord heights.
  interface Boundary { bl: V3; br: V3; tl: V3; tr: V3 }
  const boundaries: Boundary[] = [];
  for (let i = 0; i <= TRUSS_BAYS; i++) {
    const x = TRUSS_X0 + i * BAY, z = dz(x);
    // Local tangent (match world/bridge.ts's px,pz piling-offset convention) via a tiny finite
    // difference, so the truss stays aligned with the bridge's gentle chainZ curvature.
    const ang = Math.atan2(dz(x + 1) - dz(x - 1), 2);
    const px = -Math.sin(ang), pz = Math.cos(ang);
    boundaries.push({
      bl: { x: x + px * -HALF_W, y: deckH, z: z + pz * -HALF_W },
      br: { x: x + px * HALF_W, y: deckH, z: z + pz * HALF_W },
      tl: { x: x + px * -HALF_W, y: deckH + TRUSS_H, z: z + pz * -HALF_W },
      tr: { x: x + px * HALF_W, y: deckH + TRUSS_H, z: z + pz * HALF_W },
    });
  }

  // Count members: per boundary (verticals x2, top cross-brace x1) + per bay (bottom/top chords
  // x2 each, diagonals x2).
  const count = boundaries.length * 3 + TRUSS_BAYS * 6;
  const mat = new THREE.MeshStandardMaterial({ color: 0x5a4a3c, flatShading: true, roughness: 0.75, metalness: 0.15 });
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, count);
  const dummy = new THREE.Object3D();
  let i = 0;

  boundaries.forEach((b) => {
    addBeam(mesh, dummy, i++, b.bl, b.tl, MEMBER, MEMBER); // left vertical
    addBeam(mesh, dummy, i++, b.br, b.tr, MEMBER, MEMBER); // right vertical
    addBeam(mesh, dummy, i++, b.tl, b.tr, MEMBER, MEMBER); // top lateral brace
  });
  for (let k = 0; k < TRUSS_BAYS; k++) {
    const a = boundaries[k], c = boundaries[k + 1];
    addBeam(mesh, dummy, i++, a.bl, c.bl, MEMBER, MEMBER); // bottom chord, left
    addBeam(mesh, dummy, i++, a.br, c.br, MEMBER, MEMBER); // bottom chord, right
    addBeam(mesh, dummy, i++, a.tl, c.tl, MEMBER, MEMBER); // top chord, left
    addBeam(mesh, dummy, i++, a.tr, c.tr, MEMBER, MEMBER); // top chord, right
    // Alternate diagonal direction bay-to-bay (Warren-truss zig-zag).
    if (k % 2 === 0) { addBeam(mesh, dummy, i++, a.bl, c.tl, MEMBER, MEMBER); addBeam(mesh, dummy, i++, a.br, c.tr, MEMBER, MEMBER); }
    else { addBeam(mesh, dummy, i++, c.bl, a.tl, MEMBER, MEMBER); addBeam(mesh, dummy, i++, c.br, a.tr, MEMBER, MEMBER); }
  }

  mesh.castShadow = mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}
