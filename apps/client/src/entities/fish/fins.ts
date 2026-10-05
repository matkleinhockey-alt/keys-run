/**
 * Fin builders for the lofted fish body (geometry.ts's `buildFishGeo`) — caudal (tail), dorsal/
 * anal, pectoral/pelvic, and the tuna/wahoo finlet row.
 *
 * ## Why this file exists
 *
 * The task brief: fish read as "a smooth capsule with a flat triangular cone stuck on the back"
 * once the catch portrait got real PBR lighting — every fin here used to be built as a single
 * flat `THREE.ShapeGeometry` polygon (zero out-of-plane extent) lofted straight from legacy. A
 * flat polygon has one uniform normal across its whole surface (`ShapeGeometry` samples its
 * curves into 2D points and triangulates in-plane — there's nothing for `computeVertexNormals`
 * to vary), so under real specular it reads exactly as "a flat blade", regardless of how good the
 * *silhouette* tracing is. The silhouette tracing (per-species tail/dor/anal control points below)
 * was already good — that part is kept essentially verbatim.
 *
 * ## The fix: `finGeo` — bow, don't flatten
 *
 * `finGeo(pts, bowZ)` builds the exact same flat 2D silhouette (same `moveTo`/`lineTo` points,
 * same earcut triangulation via `THREE.ShapeGeometry`) but, before the shape-space -> body-space
 * rotation, displaces each vertex *out of the flat plane* by `bowZ[i]` (verified empirically that
 * `ShapeGeometry`'s output vertex order/count exactly match the input point array for a
 * line-only `Shape`, even a concave one like a forked tail's notch — see this task's scratch
 * verification — so indexing `bowZ` by the same index as `pts` is safe). Zero at the fin's rigid
 * attachment points (and, for forked/lunate/lyre/hetero tails, at the shared inner notch — real
 * tail lobes are pinched there too), ramping up toward the free margin/tip. The result is a
 * membrane that gently bows away from the body's sagittal plane, so `computeVertexNormals` (run
 * *after* the bow, deliberately re-run rather than inherited from `ShapeGeometry`'s flat default)
 * produces smoothly varying normals across the surface — a real curved fin under specular,
 * instead of a cardboard cutout — at **zero added vertex/triangle cost** versus the original flat
 * polygon; `finGeo` always produces exactly as many vertices as `pts.length`.
 *
 * Dorsal/anal/pectoral/pelvic fins are built the same way, from their own base→edge curves.
 *
 * `buildTail`'s `S.tail === 'flukes'` branch (dolphin) is untouched on purpose — marine mammals
 * are another agent's scope (see this task's brief); that one case is copied verbatim rather than
 * run through `finGeo`, so dolphin's rendered shape doesn't shift out from under that work.
 */
import * as THREE from 'three';
import type { CreatureVis, FishShape } from '@keysrun/shared/content/creatures';
import { lerp, clamp } from '../../core/math.js';
import { TM, type GeoPart, type BodyProfile, type FishDetail } from './body.js';

type Pt = [number, number];

/** legacy `finEdge(style,u)` (index.html:2349-2361) — unchanged. */
export function finEdge(style: string, u: number): number {
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

/** See this file's header: builds a flat silhouette, bows it out of plane by `bowZ[i]` per
 * vertex (same index as `pts[i]`), then recomputes normals so the curvature actually shades.
 * `pts`/`bowZ` are in the fin's local (alongBody, height) plane, same convention legacy's
 * `sideFin` used — rotated into the body's sagittal plane the same way (`rotateY(-PI/2)`), just
 * after the bow is applied instead of before (order matters: the bow is a local-Z push, and the
 * rotation is what turns local Z into body-space X — bowing after flattens it back out). */
function finGeo(pts: readonly Pt[], bowZ: readonly number[]): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  const g = new THREE.ShapeGeometry(s);
  const pos = g.attributes.position;
  for (let i = 0; i < pts.length && i < pos.count; i++) pos.setZ(i, bowZ[i] ?? 0);
  pos.needsUpdate = true;
  g.deleteAttribute('normal');
  g.rotateY(-Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

/** Fraction of a fin's own max height/width that becomes its peak out-of-plane bow — see this
 * file's header. Small enough not to read as a scoop/sail at a glance, large enough to break the
 * single-normal flat look under the portrait's specular. */
const BOW_FRAC = 0.16;

/** legacy `buildFishGeo`'s dorsal/anal loop (`addMidFin`, index.html:2:2371-2381 era) — same base/
 * edge construction, now bowed (zero at the body-attached base row, peaking mid-span on the free
 * edge row, tapering to zero at both leading/trailing tips) instead of flattened.
 * `steps` is the one thing `detail` varies here (14 at `'low'`, matching legacy exactly; higher
 * at `'high'` for the portrait-only mesh — see body.ts's header). */
function buildMidFin(spec: readonly [number, number, number, string], top: boolean, L: number, profile: BodyProfile, fin: THREE.Color, steps: number): GeoPart {
  const [t0, t1, hgt, style] = spec;
  const pts: Pt[] = [], bowZ: number[] = [];
  const maxH = hgt * profile.Hh;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps, t = lerp(t0, t1, u), z = -L / 2 + t * L;
    const yb = top ? profile.topY(t) - 0.004 : profile.botY(t) + 0.004;
    pts.push([z, yb]); bowZ.push(0);
  }
  for (let i = steps; i >= 0; i--) {
    const u = i / steps, t = lerp(t0, t1, u), z = -L / 2 + t * L;
    const yb = top ? profile.topY(t) - 0.004 : profile.botY(t) + 0.004;
    const e = finEdge(style, u) * hgt * profile.Hh;
    pts.push([z + e * 0.35, yb + (top ? e : -e)]);
    bowZ.push(BOW_FRAC * maxH * Math.sin(Math.PI * u));
  }
  return { g: finGeo(pts, bowZ), m: new THREE.Matrix4(), c: fin };
}

export function buildMidFins(S: FishShape, L: number, profile: BodyProfile, fin: THREE.Color, detail: FishDetail): GeoPart[] {
  const steps = detail === 'high' ? 20 : 14;
  const parts: GeoPart[] = [];
  (S.dor || []).forEach((s) => parts.push(buildMidFin(s, true, L, profile, fin, steps)));
  (S.anal || []).forEach((s) => parts.push(buildMidFin(s, false, L, profile, fin, steps)));
  return parts;
}

/** legacy `buildFishGeo`'s tail switch (index.html:2362-2424's tail block) — same per-style
 * control points (species-appropriate: deeply forked for mahi/tuna/jacks, lunate for billfish/
 * wahoo, rounded for grouper/snapper, heterocercal for sharks), now bowed via `finGeo` instead of
 * a flat `ShapeGeometry`. `'deepfork'` is new (tarpon only — see creatures.ts), for the brief's
 * "tarpon's distinctive deep fork": same construction as `'fork'`, longer lobes and a notch
 * pulled in closer to the body.
 *
 * Each style's second array is the per-point bow weight (0 at every rigid attachment point *and*
 * at the shared inner notch for two-lobed tails — a notch is a pinch point, not free margin;
 * peaking at 1 at the outermost tip of each lobe). `'flukes'` (dolphin) is untouched — see this
 * file's header. */
export function buildTail(S: FishShape, Hh: number, W: number, L: number, fin: THREE.Color, back: THREE.Color): GeoPart[] {
  const z0 = L / 2 - 0.01, p = Hh / 2 * S.ped, tl = L * S.tl, th = Hh / 2 * S.th * 1.6;
  const bow = Math.min(th * 0.3, L * 0.05);
  const place = (pts: readonly Pt[], w: readonly number[]): GeoPart => ({
    g: finGeo(pts.map(([a, b]): Pt => [z0 + a, b]), w.map((x) => x * bow)),
    m: new THREE.Matrix4(),
    c: fin,
  });

  switch (S.tail) {
    case 'lunate':
      return [place(
        [[0, p * 0.6], [tl * 0.5, th * 0.55], [tl, th], [tl * 0.66, th * 0.3], [tl * 0.5, 0], [tl * 0.66, -th * 0.3], [tl, -th], [tl * 0.5, -th * 0.55], [0, -p * 0.6]],
        [0, 0.6, 1, 0.5, 0, 0.5, 1, 0.6, 0],
      )];
    case 'truncate':
      return [place(
        [[0, p], [tl * 0.85, th * 0.8], [tl, th * 0.62], [tl * 0.97, 0], [tl, -th * 0.62], [tl * 0.85, -th * 0.8], [0, -p]],
        [0, 0.6, 0.9, 1, 0.9, 0.6, 0],
      )];
    case 'round': {
      const pts: Pt[] = [[0, p]], w: number[] = [0];
      for (let i = 0; i <= 8; i++) { const a = Math.PI / 2 - i / 8 * Math.PI; pts.push([tl * Math.cos(a) * 0.95 + tl * 0.05, th * 0.72 * Math.sin(a)]); w.push(Math.sin(i / 8 * Math.PI)); }
      pts.push([0, -p]); w.push(0);
      return [place(pts, w)];
    }
    case 'lyre':
      return [place(
        [[0, p], [tl * 0.7, th * 0.55], [tl * 1.15, th * 1.05], [tl * 0.8, th * 0.35], [tl * 0.75, 0], [tl * 0.8, -th * 0.35], [tl * 1.15, -th * 1.05], [tl * 0.7, -th * 0.55], [0, -p]],
        [0, 0.6, 1, 0.55, 0, 0.55, 1, 0.6, 0],
      )];
    case 'hetero':
      return [place(
        [[0, p], [tl * 0.6, th * 0.75], [tl * 1.15, th * 1.25], [tl * 0.95, th * 0.55], [tl * 0.6, -th * 0.05], [tl * 0.55, -th * 0.62], [tl * 0.3, -th * 0.45], [0, -p]],
        [0, 0.6, 1, 0.4, 0, 0.5, 0.3, 0],
      )];
    case 'deepfork':
      return [place(
        [[0, p * 0.85], [tl * 0.55, th * 0.65], [tl * 1.08, th * 0.95], [tl * 0.38, 0], [tl * 1.08, -th * 0.95], [tl * 0.55, -th * 0.65], [0, -p * 0.85]],
        [0, 0.6, 1, 0, 1, 0.6, 0],
      )];
    case 'flukes': {
      // Dolphin's horizontal flukes — copied verbatim from the pre-split buildFishGeo (not run
      // through finGeo/bow; see this file's header). Untouched on purpose: marine mammals are
      // another agent's scope, so this shape must not shift out from under that work.
      const s = new THREE.Shape();
      const width = W * 2.4;
      s.moveTo(-0.02, 0);
      s.quadraticCurveTo(-width * 0.6, -tl * 0.3, -width, -tl * 0.95);
      s.quadraticCurveTo(-width * 0.5, -tl * 0.7, 0, -tl * 0.55);
      s.quadraticCurveTo(width * 0.5, -tl * 0.7, width, -tl * 0.95);
      s.quadraticCurveTo(width * 0.6, -tl * 0.3, 0.02, 0);
      const fg = new THREE.ShapeGeometry(s);
      fg.rotateX(-Math.PI / 2);
      fg.translate(0, 0, z0);
      return [{ g: fg, m: new THREE.Matrix4(), c: back }];
    }
    default:
      return [place(
        [[0, p * 0.8], [tl * 0.6, th * 0.6], [tl, th], [tl * 0.55, 0], [tl, -th], [tl * 0.6, -th * 0.6], [0, -p * 0.8]],
        [0, 0.6, 1, 0, 1, 0.6, 0],
      )];
  }
}

/** legacy finlets/keel (tunas, wahoo) — unchanged; each finlet is a 3-point triangle, too small
 * for a bow to read as anything but noise (a single triangle has exactly one normal no matter
 * what), so these stay flat exactly as before. */
export function buildFinlets(S: FishShape, V: CreatureVis, L: number, profile: BodyProfile, back: THREE.Color): GeoPart[] {
  if (!S.finlets) return [];
  const { Hh } = profile;
  const parts: GeoPart[] = [];
  const fl = new THREE.Color(V.finlet || V.fin);
  for (let i = 0; i < 7; i++) {
    const t = 0.68 + i * 0.042, z = -L / 2 + t * L, yt = profile.topY(t), yb = profile.botY(t), s = Hh * 0.07;
    parts.push({ g: finGeo([[z, yt - 0.003], [z + s * 0.9, yt + s * 0.8], [z + s * 1.1, yt - 0.003]], [0, 0, 0]), m: new THREE.Matrix4(), c: fl });
    parts.push({ g: finGeo([[z, yb + 0.003], [z + s * 0.9, yb - s * 0.8], [z + s * 1.1, yb + 0.003]], [0, 0, 0]), m: new THREE.Matrix4(), c: fl });
  }
  parts.push({ g: new THREE.BoxGeometry(profile.W * 0.42, 0.012, L * 0.09), m: TM(0, 0, L * 0.45, 0, 0, 0, 1, 1, 1), c: back });
  return parts;
}

/** Quadratic-bezier sample, `steps+1` points from `p0` to `p2` via control `p1` — used to turn
 * the pectoral/pelvic paddle's two curves (legacy's `quadraticCurveTo` pair) into a plain point
 * list so `finGeo` can bow it the same way every other fin is bowed (ShapeGeometry's own curve
 * sampling doesn't preserve a predictable vertex count/order the way a line-only Shape does — see
 * this file's header — so the curve is sampled by hand here instead). */
function quadPts(p0: Pt, p1: Pt, p2: Pt, steps: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, mt = 1 - t;
    out.push([mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0], mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]]);
  }
  return out;
}

/** legacy `pfin(len,wid)` — same two-quadratic paddle silhouette, sampled to a point list and
 * bowed (zero at the two points nearest the body attachment, peaking mid-length) instead of a
 * flat `ShapeGeometry`. */
function buildPairedFinGeo(len: number, wid: number, steps: number): THREE.BufferGeometry {
  const c1 = quadPts([0, 0], [len * 0.4, wid * 0.9], [len, wid * 0.15], steps);
  const c2 = quadPts([len, wid * 0.15], [len * 0.8, -wid * 0.3], [len * 0.25, -wid * 0.35], steps);
  const pts: Pt[] = [...c1, ...c2.slice(1), [0, 0]];
  const n = pts.length;
  const bowZ = pts.map(([x]): number => BOW_FRAC * wid * Math.sin(Math.PI * clamp(x / len, 0, 1)));
  bowZ[0] = 0; bowZ[n - 1] = 0;
  return finGeo(pts, bowZ);
}

/** legacy's pectoral+pelvic fin placement loop (index.html:2362-2424's paired-fin block) — same
 * per-side rotate/translate logic, only the geometry construction (`pfin` -> `buildPairedFinGeo`)
 * changed. `steps` follows `detail` the same way buildMidFins' does. */
export function buildPairedFins(S: FishShape, key: string, L: number, profile: BodyProfile, fin: THREE.Color, back: THREE.Color, detail: FishDetail): GeoPart[] {
  const steps = detail === 'high' ? 10 : 6;
  const { Hh, W, prof, botY } = profile;
  const parts: GeoPart[] = [];
  const pl = L * S.pec, tP = 0.22;
  for (const sx of [-1, 1]) {
    const g1 = buildPairedFinGeo(pl, pl * (S.wings ? 0.55 : 0.38), steps);
    const th2 = Math.atan2(-0.88, sx * 0.48);
    g1.rotateY(th2);
    g1.rotateZ(sx * (S.shark ? -0.35 : -0.15));
    parts.push({ g: g1, m: TM(sx * W / 2 * prof(tP) * 0.82, -Hh * 0.12, -L / 2 + tP * L, 0, 0, 0, 1, 1, 1), c: S.shark ? back : fin });
    if (!S.shark && key !== 'dolphin') {
      const g2 = buildPairedFinGeo(pl * 0.55, pl * 0.25, steps);
      g2.rotateY(Math.atan2(-0.95, sx * 0.3));
      parts.push({ g: g2, m: TM(sx * W * 0.12, botY(0.36) + 0.01, -L / 2 + 0.36 * L, 0, 0, 0, 1, 1, 1), c: fin });
    }
  }
  return parts;
}
