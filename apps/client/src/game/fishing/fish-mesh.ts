/**
 * A generic procedural fish body (legacy `makeFishMesh`, index.html:2623-2626) — a simple
 * body+tail blob, species-colored. Legacy also had a second, far more detailed per-species body
 * (`VGEO`/`SHAPE`, built by `buildFishGeo`) that this port does not have: that lofted-body
 * system lives in entities/fish/** (docs/ARCHITECTURE.md's fish agent, not this task — see the
 * task brief's "Do NOT edit entities/fish/**"), which hadn't landed on `integration` yet when
 * fishing/spearfishing were ported. Every place that would have used `VGEO[key]` here
 * (the hooked-fish mesh, the jump animation, the catch portrait, the speared-fish target) uses
 * this generic mesh instead, sized from the species/weight the same way legacy scaled `VGEO`
 * (`clamp(Math.cbrt(weight/avgWeight),.75,1.5)`). **Integration seam**: swap `makeFishMesh`’s
 * call sites for the real per-species geometry once entities/fish/** lands — nothing here
 * assumes a generic body on purpose, it's just what was available.
 */
import * as THREE from 'three';

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function matFor(color: string): THREE.MeshStandardMaterial {
  let m = matCache.get(color);
  if (!m) { m = new THREE.MeshStandardMaterial({ color, flatShading: true, metalness: 0.3, roughness: 0.4 }); matCache.set(color, m); }
  return m;
}

/** legacy `makeFishMesh(color)`. `lenM` scales the group so `group`'s overall length (snout to
 * tail tip) is approximately `lenM` meters. */
export function makeFishMesh(color: string, lenM = 1): THREE.Group {
  const g = new THREE.Group();
  const m = matFor(color);
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), m);
  body.scale.set(0.2, 0.32, 1);
  g.add(body);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.6, 4), m);
  tail.rotation.x = -Math.PI / 2;
  tail.scale.set(0.25, 1, 1);
  tail.position.z = 1.15;
  g.add(tail);
  g.scale.setScalar(lenM / 2); // the unscaled body+tail run roughly 2m nose-to-tail
  return g;
}
