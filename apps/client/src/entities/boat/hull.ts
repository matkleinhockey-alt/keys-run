/**
 * Lofted hull geometry (deadrise, chines, flare, sheer spring, raked stem, steps) and the
 * high-performance outboard model. Ported faithfully from legacy/index.html:1001-1106.
 *
 * Used both by the player's boat (model.ts, makeBoat) and by the decorative dock/mooring boats
 * (world/marinas.ts), exactly as in legacy.
 */
import * as THREE from 'three';
import { clamp, lerp } from '../../core/math.js';
import type { HullSpec } from '@keysrun/shared/content/boats';

export const sstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export interface HullStation {
  t: number; z: number; b: number; bs: number; yk: number; yc: number; ys: number; bf: number;
}

/** legacy `hullStation` (index.html:1004-1015). */
export function hullStation(H: HullSpec, L: number, B: number, t: number): HullStation {
  const e = H.entry, bf = t < e ? 1 : Math.sqrt(Math.max(0, 1 - Math.pow((t - e) / (1 - e), 2)));
  const e2 = Math.min(0.9, e + 0.08), bfs = t < e2 ? 1 : Math.sqrt(Math.max(0, 1 - Math.pow((t - e2) / (1 - e2), 2)));
  const tuck = t < 0.06 ? 0.95 + 0.05 * t / 0.06 : 1;
  const b = B / 2 * 0.92 * bf * tuck, bs = B / 2 * bfs * tuck;
  let yk = -H.yk + Math.pow(Math.max(0, t - 0.55) / 0.45, 1.8) * (H.yk + H.F * 0.3);
  for (const s of H.steps) if (t < s) yk += 0.05;
  const ys = H.F + H.spring * Math.pow(t, 2.2);
  const dr = lerp(H.dr0, H.dr1, sstep(0.3, 1, t)) * Math.PI / 180;
  const yc = Math.min(yk + b * Math.tan(dr), ys - 0.2);
  return { t, z: L / 2 - t * (L - H.rake * 0.5), b, bs, yk, yc, ys, bf };
}

/** legacy `zRake` (index.html:1016). */
export function zRake(H: HullSpec, st: HullStation, y: number): number {
  return st.z - H.rake * clamp((y - st.yk) / Math.max(0.01, st.ys - st.yk), 0, 1) * sstep(0.62, 1, st.t);
}

interface Profile { pts: Array<[number, number]>; segc: number[] }

/** legacy `hullProfile` (index.html:1017-1022). */
function hullProfile(H: HullSpec, st: HullStation, B: number): Profile {
  const C = H.colors, led = B * 0.025 * st.bf, x0 = st.b + led, y0 = st.yc + 0.01;
  const pts: Array<[number, number]> = [[0, st.yk], [st.b * 0.5, st.yk + (st.yc - st.yk) * 0.42], [st.b, st.yc], [x0, y0]];
  const segc: number[] = [C.bottom, C.bottom, C.boot];
  ([0.1, 0.6, 0.68, 0.93, 1] as const).forEach((f, k) => {
    pts.push([lerp(x0, st.bs, f) + Math.sin(f * Math.PI) * B * 0.012 * st.bf, lerp(y0, st.ys, f)]);
    segc.push([C.boot, C.hull, C.cove || C.hull, C.hull, C.rub][k]);
  });
  return { pts, segc };
}

export interface HullGeoOptions { xo?: number; deck?: boolean }

/** legacy `buildHullGeo` (index.html:1023-1054). */
export function buildHullGeo(H: HullSpec, L: number, B: number, o: HullGeoOptions = {}): THREE.BufferGeometry {
  const xo = o.xo || 0, NS = 36;
  const P: number[] = [], Cc: number[] = [];
  const col = new THREE.Color();
  const quad = (a: number[], b: number[], c: number[], d: number[], hex: number) => {
    P.push(...a, ...b, ...c, ...a, ...c, ...d);
    col.setHex(hex);
    for (let i = 0; i < 6; i++) Cc.push(col.r, col.g, col.b);
  };
  const tri = (a: number[], b: number[], c: number[], hex: number) => {
    P.push(...a, ...b, ...c);
    col.setHex(hex);
    for (let i = 0; i < 3; i++) Cc.push(col.r, col.g, col.b);
  };
  const sts: HullStation[] = [];
  for (let i = 0; i <= NS; i++) sts.push(hullStation(H, L, B, i / NS));
  const pr = sts.map((st) => hullProfile(H, st, B));
  const V = (st: HullStation, x: number, y: number): number[] => [x + xo, y, zRake(H, st, y)];
  for (let i = 0; i < NS; i++) {
    const A = sts[i], Z = sts[i + 1], pa = pr[i].pts, pb = pr[i + 1].pts;
    for (let k = 0; k < pa.length - 1; k++) {
      for (const sx of [1, -1]) {
        quad(V(A, sx * pa[k][0], pa[k][1]), V(A, sx * pa[k + 1][0], pa[k + 1][1]), V(Z, sx * pb[k + 1][0], pb[k + 1][1]), V(Z, sx * pb[k][0], pb[k][1]), pr[i].segc[k]);
      }
    }
  }
  // transom
  const S0 = sts[0];
  const ring: Array<[number, number]> = [...pr[0].pts.map((p) => [-p[0], p[1]] as [number, number]).reverse(), ...pr[0].pts.slice(1)];
  const cy = (S0.yk + S0.ys) / 2;
  for (let j = 0; j < ring.length - 1; j++) {
    const my = (ring[j][1] + ring[j + 1][1]) / 2;
    const center = V(S0, 0, cy); center[2] = S0.z;
    tri(center, [ring[j][0] + xo, ring[j][1], S0.z], [ring[j + 1][0] + xo, ring[j + 1][1], S0.z], my < S0.yc ? H.colors.bottom : H.colors.hull);
  }
  if (o.deck) {
    const C = H.colors, D = 0.55 + L * 0.012, cap = 0.14 + B * 0.02;
    const inn = (st: HullStation) => Math.max(0, st.bs - cap);
    const sole = (st: HullStation) => st.ys - D * (1 - 0.4 * sstep(0.55, 0.85, st.t));
    for (let i = 0; i < NS; i++) {
      const A = sts[i], Z = sts[i + 1];
      for (const sx of [1, -1]) {
        quad(V(A, sx * A.bs, A.ys + 0.002), V(A, sx * inn(A), A.ys + 0.01), V(Z, sx * inn(Z), Z.ys + 0.01), V(Z, sx * Z.bs, Z.ys + 0.002), C.cap);
        quad(V(A, sx * inn(A), A.ys), V(A, sx * inn(A), sole(A)), V(Z, sx * inn(Z), sole(Z)), V(Z, sx * inn(Z), Z.ys), C.liner);
      }
      quad(V(A, -inn(A), sole(A)), V(A, inn(A), sole(A)), V(Z, inn(Z), sole(Z)), V(Z, -inn(Z), sole(Z)), C.deck);
    }
    const zi = S0.z - cap;
    quad([-inn(S0) + xo, sole(S0), zi], [inn(S0) + xo, sole(S0), zi], [inn(S0) + xo, S0.ys, zi], [-inn(S0) + xo, S0.ys, zi], C.liner);
    quad([-S0.bs + xo, S0.ys + 0.01, S0.z], [S0.bs + xo, S0.ys + 0.01, S0.z], [inn(S0) + xo, S0.ys + 0.01, zi], [-inn(S0) + xo, S0.ys + 0.01, zi], C.cap);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(Cc, 3));
  g.computeVertexNormals();
  return g;
}

/** legacy `beamBetween` (index.html:1101). */
export function beamBetween(p1: THREE.Vector3, p2: THREE.Vector3, r: number, mat: THREE.Material): THREE.Mesh {
  const d = new THREE.Vector3().subVectors(p2, p1), len = d.length();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), mat);
  m.position.copy(p1).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  m.castShadow = true;
  return m;
}

/** legacy `panelBetween` (index.html:1102). */
export function panelBetween(p1: THREE.Vector3, p2: THREE.Vector3, w: number, th: number, mat: THREE.Material): THREE.Mesh {
  const d = new THREE.Vector3().subVectors(p2, p1), len = d.length();
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, th), mat);
  m.position.copy(p1).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  m.castShadow = true;
  return m;
}

/** legacy `roundRectShape` (index.html:1103-1105). */
export function roundRectShape(w: number, l: number, r: number, front = 1): THREE.Shape {
  const s = new THREE.Shape(), hw = w / 2, hl = l / 2, fw = hw * front;
  s.moveTo(-hw + r, -hl); s.lineTo(hw - r, -hl); s.quadraticCurveTo(hw, -hl, hw, -hl + r); s.lineTo(fw, hl - r); s.quadraticCurveTo(fw, hl, fw - r, hl);
  s.lineTo(-fw + r, hl); s.quadraticCurveTo(-fw, hl, -fw, hl - r); s.lineTo(-hw, -hl + r); s.quadraticCurveTo(-hw, -hl, -hw + r, -hl);
  return s;
}

/** legacy `makeOutboard` (index.html:1055-1099): a Mercury-Racing-450R-class outboard. */
export function makeOutboard(st: HullSpec['style'], drop: number, props: THREE.Group[]): THREE.Group {
  const g = new THREE.Group();
  const M = (c: number, r = 0.22, m = 0.35) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.Mesh => {
    const o = new THREE.Mesh(geo, mat);
    o.position.set(x, y, z); o.rotation.set(rx, ry, rz); o.castShadow = true; g.add(o);
    return o;
  };
  const cowl = M(st.eng, 0.16, 0.45), low = M(st.engLow, 0.3, 0.4), acc = M(st.engAcc, 0.25, 0.5), steel = M(0xc9ced3, 0.18, 0.9), dark = M(0x0b0c0e, 0.5, 0.2);

  const sp = new THREE.Shape();
  sp.moveTo(0.4, 0); sp.lineTo(0.42, 0.52); sp.quadraticCurveTo(0.4, 0.82, 0.22, 0.95); sp.lineTo(-0.22, 0.88); sp.quadraticCurveTo(-0.4, 0.78, -0.44, 0.5); sp.lineTo(-0.42, 0); sp.lineTo(0.4, 0);
  const cg = new THREE.ExtrudeGeometry(sp, { depth: 0.56, bevelEnabled: true, bevelSize: 0.035, bevelThickness: 0.04, bevelSegments: 1, curveSegments: 8 });
  cg.rotateY(Math.PI / 2); cg.translate(-0.28, 0, 0);
  const cp = cg.attributes.position;
  for (let i = 0; i < cp.count; i++) {
    const z = cp.getZ(i), y = cp.getY(i);
    cp.setX(i, cp.getX(i) * (1 - 0.2 * Math.max(0, z) / 0.44) * (1 - 0.08 * Math.max(0, y - 0.6) / 0.35));
  }
  cg.computeVertexNormals();
  add(cg, cowl, 0, 0.12, 0.06);

  add(new THREE.BoxGeometry(0.36, 0.03, 0.2), dark, 0, 1.08, -0.08, -0.12);
  for (let i = 0; i < 5; i++) add(new THREE.BoxGeometry(0.34, 0.012, 0.02), cowl, 0, 1.095, -0.16 + i * 0.04, -0.12);
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) add(new THREE.BoxGeometry(0.012, 0.035, 0.16), dark, sx * 0.3, 0.42 + i * 0.06, -0.22 + i * 0.02);
    add(new THREE.BoxGeometry(0.012, 0.04, 0.62), acc, sx * 0.305, 0.84, 0.0, 0.12);
    add(new THREE.BoxGeometry(0.012, 0.028, 0.34), acc, sx * 0.312, 0.24, 0.18, -0.04);
  }

  const rr = new THREE.Shape();
  rr.moveTo(-0.27, -0.36); rr.lineTo(0.27, -0.36); rr.quadraticCurveTo(0.3, -0.36, 0.3, -0.3); rr.lineTo(0.27, 0.4); rr.quadraticCurveTo(0.25, 0.44, 0.2, 0.44);
  rr.lineTo(-0.2, 0.44); rr.quadraticCurveTo(-0.25, 0.44, -0.27, 0.4); rr.lineTo(-0.3, -0.3); rr.quadraticCurveTo(-0.3, -0.36, -0.27, -0.36);
  const chap = new THREE.ExtrudeGeometry(rr, { depth: 0.22, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 1 });
  chap.rotateX(-Math.PI / 2);
  add(chap, low, 0, -0.1, 0.06);

  for (const sx of [-1, 1]) {
    add(new THREE.BoxGeometry(0.05, 0.42, 0.2), low, sx * 0.17, -0.15, -0.36);
    add(new THREE.CylinderGeometry(0.035, 0.035, 0.48, 10), steel, sx * 0.09, -0.38, -0.26, 0.45);
  }
  add(new THREE.CylinderGeometry(0.03, 0.03, 0.56, 10), steel, 0, 0.02, -0.32, 0, 0, Math.PI / 2);

  const ms = new THREE.CylinderGeometry(0.13, 0.12, 1, 12);
  ms.scale(1, 1, 1.5);
  const msMesh = add(ms, low, 0, -0.2 - drop / 2, 0.12);
  msMesh.scale.set(1, drop, 1);
  add(new THREE.BoxGeometry(0.4, 0.025, 0.58), low, 0, -drop - 0.12, 0.16);
  add(new THREE.BoxGeometry(0.05, 0.02, 0.12), steel, 0.08, -drop - 0.15, 0.42);
  add(new THREE.BoxGeometry(0.06, 0.2, 0.3), low, 0, -drop - 0.22, 0.14);

  const gy = -drop - 0.34;
  add(new THREE.CylinderGeometry(0.078, 0.066, 0.56, 14), low, 0, gy, 0.12, Math.PI / 2);
  const nose = add(new THREE.SphereGeometry(0.078, 14, 10), low, 0, gy, -0.16);
  nose.scale.set(1, 1, 1.6);
  add(new THREE.BoxGeometry(0.03, 0.3, 0.24), low, 0, gy - 0.18, 0.22);

  const prop = new THREE.Group();
  prop.position.set(0, gy, 0.44);
  prop.add(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.055, 0.2, 14).rotateX(Math.PI / 2), steel));
  const bs = new THREE.Shape();
  bs.moveTo(0, 0.04); bs.quadraticCurveTo(0.07, 0.12, 0.05, 0.2); bs.lineTo(-0.03, 0.21); bs.quadraticCurveTo(-0.05, 0.12, -0.025, 0.04); bs.lineTo(0, 0.04);
  const bgeo = new THREE.ShapeGeometry(bs);
  for (let i = 0; i < 5; i++) {
    const piv = new THREE.Group();
    piv.rotation.z = i * Math.PI * 2 / 5;
    const bl = new THREE.Mesh(bgeo, new THREE.MeshStandardMaterial({ color: 0xd5d9dd, metalness: 0.95, roughness: 0.15, side: THREE.DoubleSide }));
    bl.rotation.y = 0.62;
    piv.add(bl);
    prop.add(piv);
  }
  g.add(prop);
  props.push(prop);

  g.rotation.x = -0.05;
  return g;
}
