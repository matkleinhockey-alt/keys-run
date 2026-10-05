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
 */
import * as THREE from 'three';
import type { CreatureVis, FishShape } from '@keysrun/shared/content/creatures';
import { SHAPE } from '@keysrun/shared/content/creatures';
import { clamp, lerp } from '../../core/math.js';

/** legacy `hash2` (index.html:709; reused verbatim at :2217) — same formula as world/seafloor.ts's
 * copy, duplicated rather than imported since that file is out of bounds for this task. */
const hash2 = (x: number, z: number): number => {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

/** legacy `bodyColor(V,v)` — v is the *normalized* local position (x/(W/2), y/(H/2), z/(L/2)). */
export function bodyColor(V: CreatureVis, v: THREE.Vector3): THREE.Color {
  const back = new THREE.Color(V.back), belly = new THREE.Color(V.belly ?? V.back), fin = new THREE.Color(V.fin || V.back);
  const c = belly.clone().lerp(back, clamp((v.y + 0.35) / 0.9, 0, 1));
  const hsh = hash2(v.x * 9.1 + v.z * 3.3, v.y * 7.7 + v.z * 5.1);
  if ((V.kind === 'fish' || V.kind === 'tuna') && v.z > -0.6 && v.z < -0.545 && Math.abs(v.y) < 0.62) c.multiplyScalar(0.78);
  if (V.kind === 'shark' && v.z > -0.55 && v.z < -0.35 && Math.abs(v.y) < 0.35 && Math.sin(v.z * 95) > 0.75) c.multiplyScalar(0.6);
  switch (V.pattern) {
    case 'line': if (Math.abs(v.y) < 0.08) c.set(0x26241d); break;
    case 'yline': if (Math.abs(v.y - 0.05) < 0.14) c.copy(fin); break;
    case 'spot': if (v.z > 0.62 && Math.abs(v.y - 0.12) < 0.2) c.set(0x111111); break;
    case 'spots': if (hsh > 0.8 && v.y > -0.2) c.multiplyScalar(0.6); break;
    case 'mottle': if (hsh > 0.6) c.multiplyScalar(0.75); break;
    case 'bars': if (Math.sin(v.z * 14) > 0.55 && v.y > -0.3) c.multiplyScalar(0.55); break;
    case 'lbars': if (Math.sin(v.z * 12) > 0.6 && v.y > -0.3) c.lerp(new THREE.Color(0x9fd2ff), 0.45); break;
    case 'ystripe': if (Math.abs(v.y - 0.08) < 0.09 && v.z < 0.35) c.lerp(new THREE.Color(0xf2c62e), 0.55); break;
    case 'gspots': if (hsh > 0.78 && v.y > -0.3 && v.y < 0.4) c.lerp(new THREE.Color(0xd8b84a), 0.6); break;
    case 'wbars': if (Math.sin(v.z * 22) > 0.2) c.lerp(new THREE.Color(0xf4ece4), 0.65); break;
    case 'dots': if (hsh > 0.8 && v.y > 0) c.set(0xf2f2f2); break;
    default: break;
  }
  return c;
}

export interface GeoPart {
  g: THREE.BufferGeometry;
  m: THREE.Matrix4;
  c?: THREE.Color;
  col?: (local: THREE.Vector3) => THREE.Color;
  deform?: (v: THREE.Vector3) => void;
}

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

const _dummy = new THREE.Object3D();
/** legacy `TM(px,py,pz,rx,ry,rz,sx,sy,sz)` — a one-shot transform matrix via a shared dummy. */
function TM(px: number, py: number, pz: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number): THREE.Matrix4 {
  _dummy.position.set(px, py, pz);
  _dummy.rotation.set(rx || 0, ry || 0, rz || 0);
  _dummy.scale.set(sx, sy, sz);
  _dummy.updateMatrix();
  return _dummy.matrix.clone();
}

const sph = (a?: number, b?: number): THREE.SphereGeometry => new THREE.SphereGeometry(1, a || 14, b || 10);

/** Cetaceans (dolphin + the two whale species) share "no pelvic fin, dark whole eye" styling in
 * `buildFishGeo` below — legacy only ever had `key === 'dolphin'` to check against; this
 * generalises that to the new whale keys without duplicating the special-casing per species. The
 * dolphin's long beak cone stays dolphin-only (`key === 'dolphin'` lower down) since neither whale
 * has one. */
const CETACEAN_KEYS = new Set(['dolphin', 'pilotwhale', 'humpback']);

/** legacy `buildCreatureGeoOld` (index.html:2251-2300) — rays, turtles, manatees (and the
 * fish/shark/dolphin/tuna primitive fallback body legacy kept alongside it, unused here since
 * every fish/shark/dolphin/tuna VIS entry has a SHAPE and goes through buildFishGeo instead —
 * see buildCreatureGeo's dispatch, which matches legacy's own `buildCreatureGeo` exactly). */
export function buildCreatureGeoOld(V: CreatureVis): THREE.BufferGeometry {
  const L = V.len, P: GeoPart[] = [];
  const back = new THREE.Color(V.back);
  const body = () => (v: THREE.Vector3): THREE.Color => bodyColor(V, v);
  if (V.kind === 'ray') {
    P.push({
      g: sph(18, 8), m: TM(0, 0, 0, 0, 0, 0, (V.wing ?? 1) / 2, L * 0.07, L / 2), col: body(),
      deform: (v) => { v.z *= 1 - 0.35 * Math.abs(v.x); },
    });
    P.push({ g: new THREE.CylinderGeometry(0.012, 0.03, 1, 4), m: TM(0, 0, L / 2 + L * 0.6, Math.PI / 2, 0, 0, 1, L * 1.2, 1), c: back });
    if (V.flap) P.push({ g: sph(8, 6), m: TM(0, 0, -L * 0.5, 0, 0, 0, L * 0.12, L * 0.08, L * 0.14), c: back });
  } else if (V.kind === 'turtle') {
    P.push({ g: sph(12, 8), m: TM(0, 0, 0, 0, 0, 0, L * 0.42, L * 0.18, L * 0.55), col: body() });
    P.push({ g: sph(8, 6), m: TM(0, 0, -L * 0.62, 0, 0, 0, L * 0.12, L * 0.1, L * 0.15), c: new THREE.Color(V.belly) });
    for (const sx of [-1, 1]) {
      P.push({ g: new THREE.BoxGeometry(1, 1, 1), m: TM(sx * L * 0.45, -0.02, -L * 0.22, 0, -sx * 0.45, 0, L * 0.55, 0.035, L * 0.17), c: new THREE.Color(V.belly) });
      P.push({ g: new THREE.BoxGeometry(1, 1, 1), m: TM(sx * L * 0.25, -0.02, L * 0.45, 0, sx * 0.5, 0, L * 0.22, 0.03, L * 0.12), c: new THREE.Color(V.belly) });
    }
  } else if (V.kind === 'manatee') {
    P.push({
      g: sph(), m: TM(0, 0, 0, 0, 0, 0, L * 0.32, L * 0.27, L * 0.5), col: body(),
      deform: (v) => { const k = 1 - 0.35 * Math.max(0, v.z); v.x *= k; v.y *= k; },
    });
    P.push({ g: sph(10, 6), m: TM(0, 0, L * 0.58, 0, 0, 0, L * 0.28, 0.04, L * 0.17), c: back });
    P.push({ g: sph(8, 6), m: TM(0, -L * 0.03, -L * 0.52, 0, 0, 0, L * 0.13, L * 0.11, L * 0.1), c: back });
    for (const sx of [-1, 1]) P.push({ g: new THREE.BoxGeometry(1, 1, 1), m: TM(sx * L * 0.32, -L * 0.08, -L * 0.2, 0, 0, sx * 0.5, L * 0.2, 0.04, L * 0.09), c: back });
  } else {
    // legacy's generic fish/shark/dolphin primitive body — dead code there (every such VIS entry
    // has a SHAPE), kept only so this dispatcher never throws on an unexpected kind.
    const H = V.h || L * 0.17, W = V.w || L * 0.16, taper = V.kind === 'fish' ? 0.45 : 0.62;
    P.push({
      g: sph(), m: TM(0, 0, 0, 0, 0, 0, W / 2, H / 2, L / 2), col: body(),
      deform: (v) => { const k = 1 - taper * Math.max(0, v.z); v.x *= k; v.y *= k; },
    });
  }
  return mergeParts(P);
}

/** legacy `finEdge(style,u)` (index.html:2349-2361). */
function finEdge(style: string, u: number): number {
  switch (style) {
    case 'tri': return u < 0.28 ? u / 0.28 : 1 - (u - 0.28) / 0.72 * 0.88;
    case 'sickle': return u < 0.18 ? u / 0.18 : Math.pow(1 - (u - 0.18) / 0.82, 2.3) * 0.95 + 0.05;
    case 'long': return (u < 0.08 ? u / 0.08 : 1) * (0.75 + 0.25 * Math.sin(Math.PI * u)) * (u > 0.92 ? (1 - u) / 0.08 : 1);
    case 'sail': return Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.15)), 0.55) * (1 - 0.35 * u);
    case 'spiny': return (u < 0.15 ? u / 0.15 : 1 - (u - 0.15) * 0.5) * (Math.floor(u * 14) % 2 ? 0.82 : 1);
    case 'round': return Math.sin(Math.PI * u);
    case 'filament': return u < 0.5 ? 0.4 + u * 1.2 : 1 - (u - 0.5) * 1.6;
    case 'trail': return (u < 0.1 ? u / 0.1 : 1) * (0.7 + 0.6 * u);
    default: return Math.sin(Math.PI * u);
  }
}

/** legacy `buildFishGeo` (index.html:2362-2424) — the lofted, SHAPE-driven fish/shark/dolphin/tuna
 * body: superellipse cross-section tapered along a nose/peduncle profile, with dorsal/anal fins
 * following the body outline, a tail shaped by `SHAPE.tail`, optional finlets/keels, pectoral/
 * pelvic fins, eyes, mouth, and bill/beak/hammer special cases. */
export function buildFishGeo(key: string, V: CreatureVis): THREE.BufferGeometry {
  const S: FishShape = SHAPE[key] ?? SHAPE.mangrove;
  const L = V.len, Hh = V.h || L * 0.17, W = V.w || L * 0.16, NS = 30, NR = 20, n = 2.3;
  const parts: GeoPart[] = [];
  const fin = new THREE.Color(V.fin || V.back), back = new THREE.Color(V.back);
  const prof = (t: number): number => (t < S.peak ? Math.pow(Math.sin(Math.PI / 2 * t / S.peak), S.nose) : lerp(1, S.ped, Math.pow((t - S.peak) / (1 - S.peak), 1.25)));
  const hump = (t: number): number => 1 + (S.hump || 0) * Math.max(0, 1 - t / 0.35);
  const topY = (t: number): number => Hh / 2 * prof(t) * hump(t);
  const botY = (t: number): number => -Hh / 2 * prof(t) * (S.belly || 1);

  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const colorVec = new THREE.Vector3();
  for (let i = 0; i <= NS; i++) {
    const t = i / NS, z = -L / 2 + t * L, k = prof(t);
    for (let j = 0; j <= NR; j++) {
      const a = j / NR * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const x = W / 2 * k * Math.sign(ca) * Math.pow(Math.abs(ca), 2 / n);
      let y = Hh / 2 * k * Math.sign(sa) * Math.pow(Math.abs(sa), 2 / n);
      y *= sa < 0 ? (S.belly || 1) : hump(t);
      pos.push(x, y, z);
      colorVec.set(x / (W / 2 + 1e-6), y / (Hh / 2), z / (L / 2));
      const c = bodyColor(V, colorVec);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < NS; i++) {
    for (let j = 0; j < NR; j++) {
      const a = i * (NR + 1) + j, b = a + NR + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  bg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  bg.setIndex(idx);
  bg.computeVertexNormals();
  parts.push({ g: bg, m: new THREE.Matrix4() });

  const I4 = new THREE.Matrix4();
  const shapeGeo = (pts: Array<[number, number]>): THREE.ShapeGeometry => {
    const s = new THREE.Shape();
    s.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
    return new THREE.ShapeGeometry(s);
  };
  const sideFin = (pts: Array<[number, number]>): THREE.BufferGeometry => {
    const g = shapeGeo(pts);
    g.rotateY(-Math.PI / 2);
    return g;
  };

  const addMidFin = (spec: readonly [number, number, number, string], top: boolean): void => {
    const [t0, t1, hgt, style] = spec;
    const base: Array<[number, number]> = [], edge: Array<[number, number]> = [];
    for (let i = 0; i <= 14; i++) {
      const u = i / 14, t = lerp(t0, t1, u), z = -L / 2 + t * L;
      const yb = top ? topY(t) - 0.004 : botY(t) + 0.004;
      const e = finEdge(style, u) * hgt * Hh;
      base.push([z, yb]);
      edge.push([z + e * 0.35, yb + (top ? e : -e)]);
    }
    parts.push({ g: sideFin([...base, ...edge.reverse()]), m: I4, c: fin });
  };
  (S.dor || []).forEach((s) => addMidFin(s, true));
  (S.anal || []).forEach((s) => addMidFin(s, false));

  // tail
  const z0 = L / 2 - 0.01, p = Hh / 2 * S.ped, tl = L * S.tl, th = Hh / 2 * S.th * 1.6;
  let tp: Array<[number, number]> | null;
  switch (S.tail) {
    case 'lunate': tp = [[0, p * 0.6], [tl * 0.5, th * 0.55], [tl, th], [tl * 0.66, th * 0.3], [tl * 0.5, 0], [tl * 0.66, -th * 0.3], [tl, -th], [tl * 0.5, -th * 0.55], [0, -p * 0.6]]; break;
    case 'truncate': tp = [[0, p], [tl * 0.85, th * 0.8], [tl, th * 0.62], [tl * 0.97, 0], [tl, -th * 0.62], [tl * 0.85, -th * 0.8], [0, -p]]; break;
    case 'round': {
      tp = [[0, p]];
      for (let i = 0; i <= 8; i++) { const a = Math.PI / 2 - i / 8 * Math.PI; tp.push([tl * Math.cos(a) * 0.95 + tl * 0.05, th * 0.72 * Math.sin(a)]); }
      tp.push([0, -p]);
      break;
    }
    case 'lyre': tp = [[0, p], [tl * 0.7, th * 0.55], [tl * 1.15, th * 1.05], [tl * 0.8, th * 0.35], [tl * 0.75, 0], [tl * 0.8, -th * 0.35], [tl * 1.15, -th * 1.05], [tl * 0.7, -th * 0.55], [0, -p]]; break;
    case 'hetero': tp = [[0, p], [tl * 0.6, th * 0.75], [tl * 1.15, th * 1.25], [tl * 0.95, th * 0.55], [tl * 0.6, -th * 0.05], [tl * 0.55, -th * 0.62], [tl * 0.3, -th * 0.45], [0, -p]]; break;
    case 'flukes': tp = null; break;
    default: tp = [[0, p * 0.8], [tl * 0.6, th * 0.6], [tl, th], [tl * 0.55, 0], [tl, -th], [tl * 0.6, -th * 0.6], [0, -p * 0.8]];
  }
  if (tp) {
    parts.push({ g: sideFin(tp.map(([a, b]): [number, number] => [z0 + a, b])), m: I4, c: fin });
  } else {
    const s = new THREE.Shape();
    const w = W * 2.4;
    s.moveTo(-0.02, 0);
    s.quadraticCurveTo(-w * 0.6, -tl * 0.3, -w, -tl * 0.95);
    s.quadraticCurveTo(-w * 0.5, -tl * 0.7, 0, -tl * 0.55);
    s.quadraticCurveTo(w * 0.5, -tl * 0.7, w, -tl * 0.95);
    s.quadraticCurveTo(w * 0.6, -tl * 0.3, 0.02, 0);
    const fg = new THREE.ShapeGeometry(s);
    fg.rotateX(-Math.PI / 2);
    fg.translate(0, 0, z0);
    parts.push({ g: fg, m: I4, c: back });
  }

  // finlets and caudal keels (tunas, wahoo)
  if (S.finlets) {
    const fl = new THREE.Color(V.finlet || V.fin);
    for (let i = 0; i < 7; i++) {
      const t = 0.68 + i * 0.042, z = -L / 2 + t * L, yt = topY(t), yb = botY(t), s = Hh * 0.07;
      parts.push({ g: sideFin([[z, yt - 0.003], [z + s * 0.9, yt + s * 0.8], [z + s * 1.1, yt - 0.003]]), m: I4, c: fl });
      parts.push({ g: sideFin([[z, yb + 0.003], [z + s * 0.9, yb - s * 0.8], [z + s * 1.1, yb + 0.003]]), m: I4, c: fl });
    }
    parts.push({ g: new THREE.BoxGeometry(W * 0.42, 0.012, L * 0.09), m: TM(0, 0, L * 0.45, 0, 0, 0, 1, 1, 1), c: back });
  }

  // pectoral and pelvic fins
  const pfin = (len: number, wid: number): THREE.BufferGeometry => {
    const s = new THREE.Shape();
    s.moveTo(0, 0);
    s.quadraticCurveTo(len * 0.4, wid * 0.9, len, wid * 0.15);
    s.quadraticCurveTo(len * 0.8, -wid * 0.3, len * 0.25, -wid * 0.35);
    s.lineTo(0, 0);
    const g = new THREE.ShapeGeometry(s);
    g.rotateX(-Math.PI / 2);
    return g;
  };
  const pl = L * S.pec, tP = 0.22;
  for (const sx of [-1, 1]) {
    const g1 = pfin(pl, pl * (S.wings ? 0.55 : 0.38));
    const th2 = Math.atan2(-0.88, sx * 0.48);
    g1.rotateY(th2);
    g1.rotateZ(sx * (S.shark ? -0.35 : -0.15));
    parts.push({ g: g1, m: TM(sx * W / 2 * prof(tP) * 0.82, -Hh * 0.12, -L / 2 + tP * L, 0, 0, 0, 1, 1, 1), c: S.shark ? back : fin });
    if (!S.shark && !CETACEAN_KEYS.has(key)) {
      const g2 = pfin(pl * 0.55, pl * 0.25);
      g2.rotateY(Math.atan2(-0.95, sx * 0.3));
      parts.push({ g: g2, m: TM(sx * W * 0.12, botY(0.36) + 0.01, -L / 2 + 0.36 * L, 0, 0, 0, 1, 1, 1), c: fin });
    }
  }

  // eyes, mouth, bill / beak
  const te = 0.09, ke = prof(te), ex = W / 2 * ke * 0.86, ey = Hh * 0.1 * ke + Hh * 0.04, ez = -L / 2 + te * L;
  const er = Math.max(0.008, Math.min(Hh, W) * 0.085);
  for (const sx of [-1, 1]) {
    parts.push({ g: new THREE.SphereGeometry(er, 10, 8), m: TM(sx * ex, ey, ez, 0, 0, 0, 0.6, 1, 1), c: new THREE.Color(S.shark || CETACEAN_KEYS.has(key) ? 0x1a1a1a : 0xe8dca0) });
    if (!S.shark && !CETACEAN_KEYS.has(key)) parts.push({ g: new THREE.SphereGeometry(er * 0.6, 8, 6), m: TM(sx * (ex + er * 0.35), ey, ez, 0, 0, 0, 0.5, 1, 1), c: new THREE.Color(0x0a0a0c) });
  }
  parts.push({ g: new THREE.BoxGeometry(W * 0.38 * prof(0.04), 0.006, L * 0.035), m: TM(0, -Hh * 0.06 * prof(0.04), -L / 2 + L * 0.03, 0, 0, 0, 1, 1, 1), c: new THREE.Color(0x24201c) });
  if (V.bill) parts.push({ g: new THREE.ConeGeometry(0.03, 1, 8), m: TM(0, Hh * 0.02, -L / 2 - L * V.bill / 2 + 0.04, -Math.PI / 2, 0, 0, 1, L * V.bill, 1), c: back });
  if (key === 'dolphin') parts.push({ g: new THREE.ConeGeometry(0.045, 1, 10), m: TM(0, -Hh * 0.12, -L / 2 - L * 0.05, -Math.PI / 2, 0, 0, 1, L * 0.12, 0.8), c: back });
  if (key === 'hammerhead') parts.push({ g: new THREE.BoxGeometry(L * 0.3, Hh * 0.16, L * 0.07), m: TM(0, 0, -L * 0.47, 0, 0, 0, 1, 1, 1), c: back });

  return mergeSmooth(parts);
}

/** legacy `buildCreatureGeo` dispatcher (index.html:2476). */
export function buildCreatureGeo(key: string, V: CreatureVis): THREE.BufferGeometry {
  return (V.kind === 'ray' || V.kind === 'turtle' || V.kind === 'manatee') ? buildCreatureGeoOld(V) : buildFishGeo(key, V);
}
