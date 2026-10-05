/**
 * Lofted fish body: the main superellipse-cross-section hull loft plus small head details (eyes,
 * mouth, bill/beak/hammer) — split out of geometry.ts's `buildFishGeo` so the fin builders
 * (fins.ts) and the orchestrator (geometry.ts) both have a single place to get the body's outer
 * profile from (`BodyProfile`, used to anchor dorsal/anal/pectoral fins to the hull surface).
 *
 * Geometry here is unchanged from the original port except for two additions driven directly by
 * the fish-geometry task brief:
 *  - a `detail` tier (`'low'` — the shared-InstancedMesh school body, same NS/NR as before —
 *    vs. `'high'` — a denser loft used only by the single, non-instanced meshes in
 *    game/fishing/fish-mesh.ts: the hooked fish, the grip-and-grin photo rig, and the catch
 *    portrait). Schools never pay for `'high'`.
 *  - a cheap per-vertex "eye socket" dimple: a small inward pull on the existing loft grid (no
 *    extra vertices) in the lateral band where the eye sphere sits, so the eye reads as sitting
 *    in a shallow socket rather than glued onto a perfectly convex hull.
 */
import * as THREE from 'three';
import type { CreatureVis, FishShape } from '@keysrun/shared/content/creatures';
import { clamp, lerp } from '../../core/math.js';

export type FishDetail = 'low' | 'high';

/** legacy `hash2` (index.html:709) — kept here (not imported from geometry.ts) since body.ts must
 * not depend on geometry.ts (geometry.ts depends on body.ts/fins.ts, not the other way around —
 * see this module's header and fins.ts's). Same formula as geometry.ts's copy. */
const hash2 = (x: number, z: number): number => {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

/** legacy `bodyColor(V,v)` — v is the *normalized* local position (x/(W/2), y/(H/2), z/(L/2)).
 * Identical to the copy geometry.ts re-exports (kept in one place; geometry.ts imports it from
 * here now so the primitive-creature path (buildCreatureGeoOld) and the lofted-fish path share
 * one implementation instead of two). */
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

const _dummy = new THREE.Object3D();
/** legacy `TM(px,py,pz,rx,ry,rz,sx,sy,sz)` — a one-shot transform matrix via a shared dummy. */
export function TM(px: number, py: number, pz: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number): THREE.Matrix4 {
  _dummy.position.set(px, py, pz);
  _dummy.rotation.set(rx || 0, ry || 0, rz || 0);
  _dummy.scale.set(sx, sy, sz);
  _dummy.updateMatrix();
  return _dummy.matrix.clone();
}

/** The body hull's outer-surface profile, in the (t = 0..1 along length) parametrization fins.ts
 * needs to anchor dorsal/anal/pectoral/pelvic fins flush against the hull instead of floating. */
export interface BodyProfile {
  L: number;
  Hh: number;
  W: number;
  prof(t: number): number;
  hump(t: number): number;
  topY(t: number): number;
  botY(t: number): number;
}

/** Eye position (legacy's `te`/`ex`/`ey`/`ez`), shared between the socket dimple below and
 * buildHeadDetails's eyeball placement so the dimple always lines up with the eye it hollows. */
function eyeSpec(W: number, Hh: number, L: number, prof: (t: number) => number): { te: number; ex: number; ey: number; ez: number; er: number } {
  const te = 0.09, ke = prof(te);
  return { te, ex: W / 2 * ke * 0.86, ey: Hh * 0.1 * ke + Hh * 0.04, ez: -L / 2 + te * L, er: Math.max(0.008, Math.min(Hh, W) * 0.085) };
}

/** Builds the main lofted hull (legacy `buildFishGeo`'s superellipse loft, index.html:2362-2424's
 * first half) as one indexed `GeoPart`, plus the `BodyProfile` fins.ts anchors to.
 *
 * `detail: 'high'` only raises the loft's own resolution (NS/NR) — see this module's header; it
 * does not change any shape math, so a school fish and a portrait fish of the same species are
 * the same silhouette at different tessellation. */
export function buildBodyLoft(V: CreatureVis, S: FishShape, detail: FishDetail): { part: GeoPart; profile: BodyProfile } {
  const L = V.len, Hh = V.h || L * 0.17, W = V.w || L * 0.16, n = 2.3;
  const NS = detail === 'high' ? 40 : 30, NR = detail === 'high' ? 24 : 20;
  const prof = (t: number): number => (t < S.peak ? Math.pow(Math.sin(Math.PI / 2 * t / S.peak), S.nose) : lerp(1, S.ped, Math.pow((t - S.peak) / (1 - S.peak), 1.25)));
  const hump = (t: number): number => 1 + (S.hump || 0) * Math.max(0, 1 - t / 0.35);
  const topY = (t: number): number => Hh / 2 * prof(t) * hump(t);
  const botY = (t: number): number => -Hh / 2 * prof(t) * (S.belly || 1);

  // Eye-socket dimple (brief item 3, "actual ... eye sockets"): a small inward pull on the
  // existing grid, localized to the lateral band (near full cos(a), i.e. the flank, not the
  // dorsal ridge) around the eye's length/height position — zero added vertices, zero added
  // triangles. `lat` gates it off the dorsal ridge/belly so it reads as a socket around the
  // eyeball rather than a groove running all the way round the body.
  const eye = eyeSpec(W, Hh, L, prof);
  const dimple = (t: number, y: number, lat: number): number => {
    const dt = (t - eye.te) / 0.1, dy = (y - eye.ey) / (Hh * 0.22 + 1e-6);
    const g = Math.exp(-dt * dt - dy * dy) * Math.max(0, lat - 0.35) / 0.65;
    return 1 - 0.16 * g;
  };

  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const colorVec = new THREE.Vector3();
  for (let i = 0; i <= NS; i++) {
    const t = i / NS, z = -L / 2 + t * L, k = prof(t);
    for (let j = 0; j <= NR; j++) {
      const a = j / NR * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      let x = W / 2 * k * Math.sign(ca) * Math.pow(Math.abs(ca), 2 / n);
      let y = Hh / 2 * k * Math.sign(sa) * Math.pow(Math.abs(sa), 2 / n);
      y *= sa < 0 ? (S.belly || 1) : hump(t);
      if (sa > 0.15) { const d = dimple(t, y, ca * ca); x *= d; y *= d; }
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
  return { part: { g: bg, m: new THREE.Matrix4() }, profile: { L, Hh, W, prof, hump, topY, botY } };
}

/** legacy's eyes/mouth/bill/beak/hammer parts (index.html:2362-2424's tail end) — relocated
 * verbatim from geometry.ts's old `buildFishGeo`, just parametrized off `BodyProfile` instead of
 * re-deriving `prof`/Hh/W locally. Not touched by the fin-geometry work beyond the move: these
 * were already real (if simple) geometry, not the "flat blade" problem the brief calls out. */
export function buildHeadDetails(key: string, V: CreatureVis, S: FishShape, profile: BodyProfile): GeoPart[] {
  const { L, Hh, W, prof } = profile;
  const parts: GeoPart[] = [];
  const back = new THREE.Color(V.back);
  const eye = eyeSpec(W, Hh, L, prof);
  for (const sx of [-1, 1]) {
    parts.push({ g: new THREE.SphereGeometry(eye.er, 10, 8), m: TM(sx * eye.ex, eye.ey, eye.ez, 0, 0, 0, 0.6, 1, 1), c: new THREE.Color(S.shark || key === 'dolphin' ? 0x1a1a1a : 0xe8dca0) });
    if (!S.shark && key !== 'dolphin') parts.push({ g: new THREE.SphereGeometry(eye.er * 0.6, 8, 6), m: TM(sx * (eye.ex + eye.er * 0.35), eye.ey, eye.ez, 0, 0, 0, 0.5, 1, 1), c: new THREE.Color(0x0a0a0c) });
  }
  parts.push({ g: new THREE.BoxGeometry(W * 0.38 * prof(0.04), 0.006, L * 0.035), m: TM(0, -Hh * 0.06 * prof(0.04), -L / 2 + L * 0.03, 0, 0, 0, 1, 1, 1), c: new THREE.Color(0x24201c) });
  if (V.bill) parts.push({ g: new THREE.ConeGeometry(0.03, 1, 8), m: TM(0, Hh * 0.02, -L / 2 - L * V.bill / 2 + 0.04, -Math.PI / 2, 0, 0, 1, L * V.bill, 1), c: back });
  if (key === 'dolphin') parts.push({ g: new THREE.ConeGeometry(0.045, 1, 10), m: TM(0, -Hh * 0.12, -L / 2 - L * 0.05, -Math.PI / 2, 0, 0, 1, L * 0.12, 0.8), c: back });
  if (key === 'hammerhead') parts.push({ g: new THREE.BoxGeometry(L * 0.3, Hh * 0.16, L * 0.07), m: TM(0, 0, -L * 0.47, 0, 0, 0, 1, 1, 1), c: back });
  return parts;
}
