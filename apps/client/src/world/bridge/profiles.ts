/**
 * Reusable unit geometry for the bridge's structural detail — a Jersey-barrier cross-section and
 * a semicircular arch rib. Both are built once at module load as a *unit* shape (length/span/sag
 * = 1 world unit) and meant to be driven through an `InstancedMesh`'s per-instance matrix, the
 * same convention every other shape in `world/bridge.ts` already uses (`scale.x` = run length for
 * the deck/rail boxes). That keeps every one of these an O(1)-draw-call InstancedMesh no matter
 * how many kilometres of bridge they cover — see docs/ARCHITECTURE.md "instancing" and this
 * module's own report for the draw-call accounting.
 */
import * as THREE from 'three';

/**
 * Unit-length (run = 1, centered on local X like `BoxGeometry(1,…)`) Jersey-barrier cross
 * section: a trapezoidal concrete safety wall, wide base flaring to a narrower cap — the
 * silhouette the real bridge's barrier walls read as from water level, vs. the flat thin rail
 * box this replaces. Profile is in the (length-free) Y/Z plane; extrude along Z then rotate so
 * the extrusion runs along local X, matching every other instanced run here.
 */
export function barrierGeometry(): THREE.BufferGeometry {
  const halfBase = 0.27, halfTop = 0.11, height = 0.84;
  const shape = new THREE.Shape();
  shape.moveTo(-halfBase, 0);
  shape.lineTo(halfBase, 0);
  shape.lineTo(halfTop, height);
  shape.lineTo(-halfTop, height);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 1 });
  geo.rotateY(Math.PI / 2);
  geo.translate(-0.5, 0, 0);
  geo.computeVertexNormals();
  return geo;
}

/**
 * Unit semicircular arch rib: span 2 (local X: -1..1), sag 1 (bottom at local Y -1), both
 * endpoints sitting exactly at local Y 0 — so an instance can be dropped under a deck span and
 * scaled (`scale.x` = half-span, `scale.y` = sag, `scale.z` = rib thickness across the deck) with
 * no further offset math. Low radial/tubular segment counts match this project's flat-shaded,
 * low-poly look (see world/bridge.ts's existing 8-sided piling cylinder) rather than a smooth
 * CAD-perfect torus.
 */
export function archGeometry(): THREE.BufferGeometry {
  const geo = new THREE.TorusGeometry(1, 0.09, 5, 10, Math.PI);
  geo.rotateZ(Math.PI);
  return geo;
}
