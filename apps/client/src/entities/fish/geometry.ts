/**
 * Procedural creature geometry: lofted fish bodies with real fins (`buildFishGeo`, driven by
 * `SHAPE`), and the older primitive-based rays/turtles/manatees (`buildCreatureGeoOld`).
 *
 * Ported faithfully from legacy/index.html:2215-2423 (bodyColor, mergeParts, TM, buildCreatureGeoOld,
 * SHAPE's finEdge/buildFishGeo) and :1217-1226 (mergeSmooth). Every magic number and evaluation
 * order is preserved exactly — this is the "real work" docs/ARCHITECTURE.md's task brief calls
 * out, carried across intact before any upgrade.
 *
 * Two deliberate, mechanical (non-visual) changes from legacy, both required to make this emit a
 * reusable per-species asset instead of a one-off scene mesh:
 *  - Legacy mutated `V.key=k` onto the shared VIS object before building; here `key` is threaded
 *    through as an explicit parameter so @keysrun/shared's VIS stays untouched plain data.
 *  - `bodyColor`'s per-vertex colour callback keeps writing into a `THREE.BufferAttribute` same
 *    as legacy, but the swim-cycle displacement that legacy baked into live vertex-shader
 *    attributes (`addSwimAttrs`) is split out into swim.ts, which bakes it into a vertex
 *    animation texture instead (see docs/ARCHITECTURE.md "Fish at realism *and* density").
 *
 * ## Real fin/body geometry (this task)
 *
 * `buildFishGeo` used to build the hull loft *and* every fin inline. The hull loft (real work,
 * already a proper tapered superellipse per species) moved to body.ts unchanged; every fin —
 * previously flat `ShapeGeometry` polygons that read as "a flat triangular cone" once the catch
 * portrait got real specular — moved to fins.ts, bowed instead of flattened (see that file's
 * header for why that was the actual fix). This file is now the thin call-out the task brief asked
 * for: compute `S`/colors, delegate to body.ts/fins.ts, merge. Kept here deliberately so a second
 * agent's concurrent `geometry.ts`/`creatures.ts` work (marine mammals, branch
 * `feat/marine-mammals`) only has to reconcile a short orchestrator, not fin math.
 */
import * as THREE from 'three';
import type { CreatureVis, FishShape } from '@keysrun/shared/content/creatures';
import { SHAPE } from '@keysrun/shared/content/creatures';
import { bodyColor, buildBodyLoft, buildHeadDetails, TM, DETAIL_PARAMS, type FishDetail, type GeoPart } from './body.js';
import { buildMidFins, buildTail, buildFinlets, buildPairedFins } from './fins.js';

export { bodyColor };
export type { GeoPart, FishDetail };

/** legacy `mergeParts` (index.html:2235-2249) — used by the old primitive-based creatures.
 * Concatenates each part's (possibly deformed, possibly per-vertex-coloured) triangle soup into
 * one non-indexed geometry, then computes normals over the result (flat per-triangle, since
 * nothing shares an index after this). */
export function mergeParts(parts: GeoPart[]): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [];
  const v = new THREE.Vector3(), u = new THREE.Vector3();
  for (const p of parts) {
    const g = p.g.index ? p.g.toNonIndexed() : p.g;
    const a = g.attributes.position;
    for (let i = 0; i < a.count; i++) {
      u.fromBufferAttribute(a, i);
      v.copy(u);
      if (p.deform) p.deform(v);
      const c = p.col ? p.col(u) : (p.c as THREE.Color);
      v.applyMatrix4(p.m);
      pos.push(v.x, v.y, v.z);
      col.push(c.r, c.g, c.b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

/** legacy `mergeSmooth` (index.html:1217-1226) — used by the lofted-fish-body path. Each part's
 * normals are computed (if missing) *before* un-indexing, so parts that were built indexed (the
 * main body, the fin ShapeGeometry) keep smooth shading; nothing downstream re-smooths across
 * part boundaries, matching legacy exactly. */
export function mergeSmooth(parts: GeoPart[]): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  const c = new THREE.Color();
  for (const p of parts) {
    let g = p.g.clone();
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(p.m);
    if (g.index) g = g.toNonIndexed();
    const a = g.attributes.position, nn = g.attributes.normal, ca = g.attributes.color;
    for (let i = 0; i < a.count; i++) {
      pos.push(a.getX(i), a.getY(i), a.getZ(i));
      nor.push(nn.getX(i), nn.getY(i), nn.getZ(i));
      if (ca && !p.c) col.push(ca.getX(i), ca.getY(i), ca.getZ(i));
      else { c.copy(p.c as THREE.Color); col.push(c.r, c.g, c.b); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

const sph = (a?: number, b?: number): THREE.SphereGeometry => new THREE.SphereGeometry(1, a || 14, b || 10);

/** legacy `buildCreatureGeoOld` (index.html:2251-2300) — rays, turtles, manatees (and the
 * fish/shark/dolphin/tuna primitive fallback body legacy kept alongside it, unused here since
 * every fish/shark/dolphin/tuna VIS entry has a SHAPE and goes through buildFishGeo instead —
 * see buildCreatureGeo's dispatch, which matches legacy's own `buildCreatureGeo` exactly). */
export function buildCreatureGeoOld(V: CreatureVis, detail: FishDetail = 'low'): THREE.BufferGeometry {
  // Rays/turtles/manatees are primitive-built, so their LOD lever is the primitives' own segment
  // counts rather than a body loft. `q` scales legacy's hardcoded counts by this tier's ratio to
  // 'low', floored at 3 (below that a sphere is not closed).
  const q = (base: number): number => Math.max(3, Math.round(base * (DETAIL_PARAMS[detail].ns / DETAIL_PARAMS.low.ns)));
  const L = V.len, P: GeoPart[] = [];
  const back = new THREE.Color(V.back);
  const body = () => (v: THREE.Vector3): THREE.Color => bodyColor(V, v);
  if (V.kind === 'ray') {
    P.push({
      g: sph(q(18), q(8)), m: TM(0, 0, 0, 0, 0, 0, (V.wing ?? 1) / 2, L * 0.07, L / 2), col: body(),
      deform: (v) => { v.z *= 1 - 0.35 * Math.abs(v.x); },
    });
    P.push({ g: new THREE.CylinderGeometry(0.012, 0.03, 1, 4), m: TM(0, 0, L / 2 + L * 0.6, Math.PI / 2, 0, 0, 1, L * 1.2, 1), c: back });
    if (V.flap) P.push({ g: sph(q(8), q(6)), m: TM(0, 0, -L * 0.5, 0, 0, 0, L * 0.12, L * 0.08, L * 0.14), c: back });
  } else if (V.kind === 'turtle') {
    P.push({ g: sph(q(12), q(8)), m: TM(0, 0, 0, 0, 0, 0, L * 0.42, L * 0.18, L * 0.55), col: body() });
    P.push({ g: sph(q(8), q(6)), m: TM(0, 0, -L * 0.62, 0, 0, 0, L * 0.12, L * 0.1, L * 0.15), c: new THREE.Color(V.belly) });
    for (const sx of [-1, 1]) {
      P.push({ g: new THREE.BoxGeometry(1, 1, 1), m: TM(sx * L * 0.45, -0.02, -L * 0.22, 0, -sx * 0.45, 0, L * 0.55, 0.035, L * 0.17), c: new THREE.Color(V.belly) });
      P.push({ g: new THREE.BoxGeometry(1, 1, 1), m: TM(sx * L * 0.25, -0.02, L * 0.45, 0, sx * 0.5, 0, L * 0.22, 0.03, L * 0.12), c: new THREE.Color(V.belly) });
    }
  } else if (V.kind === 'manatee') {
    P.push({
      g: sph(q(14), q(10)), m: TM(0, 0, 0, 0, 0, 0, L * 0.32, L * 0.27, L * 0.5), col: body(),
      deform: (v) => { const k = 1 - 0.35 * Math.max(0, v.z); v.x *= k; v.y *= k; },
    });
    P.push({ g: sph(q(10), q(6)), m: TM(0, 0, L * 0.58, 0, 0, 0, L * 0.28, 0.04, L * 0.17), c: back });
    P.push({ g: sph(q(8), q(6)), m: TM(0, -L * 0.03, -L * 0.52, 0, 0, 0, L * 0.13, L * 0.11, L * 0.1), c: back });
    for (const sx of [-1, 1]) P.push({ g: new THREE.BoxGeometry(1, 1, 1), m: TM(sx * L * 0.32, -L * 0.08, -L * 0.2, 0, 0, sx * 0.5, L * 0.2, 0.04, L * 0.09), c: back });
  } else {
    // legacy's generic fish/shark/dolphin primitive body — dead code there (every such VIS entry
    // has a SHAPE), kept only so this dispatcher never throws on an unexpected kind.
    const H = V.h || L * 0.17, W = V.w || L * 0.16, taper = V.kind === 'fish' ? 0.45 : 0.62;
    P.push({
      g: sph(q(14), q(10)), m: TM(0, 0, 0, 0, 0, 0, W / 2, H / 2, L / 2), col: body(),
      deform: (v) => { const k = 1 - taper * Math.max(0, v.z); v.x *= k; v.y *= k; },
    });
  }
  return mergeParts(P);
}

/** legacy `buildFishGeo` (index.html:2362-2424) — the lofted, SHAPE-driven fish/shark/dolphin/tuna
 * body: superellipse cross-section tapered along a nose/peduncle profile (body.ts), with
 * dorsal/anal fins following the body outline, a tail shaped by `SHAPE.tail`, optional finlets/
 * keels, pectoral/pelvic fins (all fins.ts), eyes, mouth, and bill/beak/hammer special cases
 * (body.ts). See this file's header and fins.ts's for why fin construction moved out and what
 * changed when it did (bowed membranes instead of flat polygons — the actual fix for "reads as a
 * flat triangular cone").
 *
 * `detail` ('low' by default) only raises tessellation for the single, non-instanced meshes in
 * game/fishing/fish-mesh.ts (hooked/photo/portrait fish) — see body.ts's and fins.ts's headers.
 * Dense InstancedMesh schools (pool.ts) never pass `'high'`. */
export function buildFishGeo(key: string, V: CreatureVis, detail: FishDetail = 'low'): THREE.BufferGeometry {
  const S: FishShape = SHAPE[key] ?? SHAPE.mangrove;
  const fin = new THREE.Color(V.fin || V.back), back = new THREE.Color(V.back);

  const { part: bodyPart, profile } = buildBodyLoft(V, S, detail);
  const parts: GeoPart[] = [bodyPart];
  parts.push(...buildMidFins(S, V.len, profile, fin, detail));
  parts.push(...buildTail(S, profile.Hh, profile.W, V.len, fin, back, detail));
  parts.push(...buildFinlets(S, V, V.len, profile, back, detail));
  parts.push(...buildPairedFins(S, key, V.len, profile, fin, back, detail));
  parts.push(...buildHeadDetails(key, V, S, profile, detail));

  return mergeSmooth(parts);
}

/** legacy `buildCreatureGeo` dispatcher (index.html:2476). */
export function buildCreatureGeo(key: string, V: CreatureVis, detail: FishDetail = 'low'): THREE.BufferGeometry {
  return (V.kind === 'ray' || V.kind === 'turtle' || V.kind === 'manatee') ? buildCreatureGeoOld(V, detail) : buildFishGeo(key, V, detail);
}
