/**
 * People: smooth-shaded bodies with two-bone IK arms, lathe-geometry torsos, faces, hair styles
 * (long/wavy/pony/bun), blinking, and distance-culled animation updates.
 *
 * Ported faithfully from legacy/index.html:1214-1357 (`setLimb`, `mergeSmooth`, `limbMatrix`,
 * `humanMat`, `HMAT`/`hmat`, `WOMAN_LOOKS`, `makeHuman`, `updateHumans`).
 *
 * r186/ACES note: `humanMat`/`hmat()` were already `MeshStandardMaterial` in legacy (PBR, not the
 * flat vertex-coloured kind the task brief warns about) — kept roughness/metalness as-is; they
 * read fine under ACES. Nothing here needed PBR rework.
 */
import * as THREE from 'three';

const _up = new THREE.Vector3(0, 1, 0);
const _ld = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();

/** legacy `setLimb` (index.html:1216): orient+scale a unit cylinder along the segment a->b. */
function setLimb(m: THREE.Object3D, a: THREE.Vector3, b: THREE.Vector3): void {
  _ld.subVectors(b, a);
  const len = _ld.length() || 0.001;
  m.position.copy(a).addScaledVector(_ld, 0.5);
  m.quaternion.setFromUnitVectors(_up, _ld.multiplyScalar(1 / len));
  m.scale.set(1, len, 1);
}

interface MergePart { g: THREE.BufferGeometry; m: THREE.Matrix4; c: THREE.Color | null }

/** legacy `mergeSmooth` (index.html:1217-1226): bake per-part transforms + colours into one
 * vertex-coloured, smooth-normal geometry (one draw call for a whole body or head). */
function mergeSmooth(parts: readonly MergePart[]): THREE.BufferGeometry {
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
      else { c.copy(p.c ?? new THREE.Color(0xffffff)); col.push(c.r, c.g, c.b); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return geo;
}

/** legacy `limbMatrix` (index.html:1227-1228) — the `r0,r1` legacy params were dead (every call
 * site passed exactly 2 args); dropped here. */
function limbMatrix(a: THREE.Vector3, b: THREE.Vector3): THREE.Matrix4 {
  const d = new THREE.Vector3().subVectors(b, a);
  const len = d.length() || 0.001;
  const q = new THREE.Quaternion().setFromUnitVectors(_up, d.clone().multiplyScalar(1 / len));
  return new THREE.Matrix4().compose(a.clone().addScaledVector(d, 0.5), q, new THREE.Vector3(1, len, 1));
}

/** legacy `TM` (index.html:2250), ported local to this module (every other world/*.ts file
 * keeps its own local `dummy`/transform-matrix helper the same way). */
const _dummy = new THREE.Object3D();
function TM(px: number, py: number, pz: number, rx: number, ry: number, rz: number, sx: number, sy: number, sz: number): THREE.Matrix4 {
  _dummy.position.set(px, py, pz);
  _dummy.rotation.set(rx, ry, rz);
  _dummy.scale.set(sx, sy, sz);
  _dummy.updateMatrix();
  return _dummy.matrix.clone();
}

const humanMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.52, metalness: 0 });
const HMAT: Record<number, THREE.MeshStandardMaterial> = {};
function hmat(c: number): THREE.MeshStandardMaterial {
  return HMAT[c] ?? (HMAT[c] = new THREE.MeshStandardMaterial({ color: c, roughness: 0.62 }));
}

/** legacy `WOMAN_LOOKS` (index.html:1233-1242). */
const WOMAN_LOOKS: ReadonlyArray<{ hair: number; skin: number; hairStyle: string; eye: number }> = [
  { hair: 0x3b2416, skin: 0xd9a27f, hairStyle: 'long', eye: 0x5a3a22 },
  { hair: 0xead27f, skin: 0xe9b48f, hairStyle: 'wavy', eye: 0x3f78b8 },
  { hair: 0x5a3825, skin: 0xc98d68, hairStyle: 'pony', eye: 0x4f7f4a },
  { hair: 0x1c1410, skin: 0xb87a55, hairStyle: 'long', eye: 0x3a2416 },
  { hair: 0x2e1c12, skin: 0xe2ad88, hairStyle: 'wavy', eye: 0x7a5a2a },
  { hair: 0x7a3a1c, skin: 0xf0c2a0, hairStyle: 'wavy', eye: 0x4f7f4a },
  { hair: 0x4a2c1a, skin: 0x9a6644, hairStyle: 'bun', eye: 0x3a2416 },
  { hair: 0xd8b46a, skin: 0xdba886, hairStyle: 'pony', eye: 0x5f8fb8 },
  { hair: 0x3f2818, skin: 0xcf9672, hairStyle: 'long', eye: 0x5a3a22 },
];

export interface HumanOptions {
  bikini?: boolean;
  skin?: number; shirt?: number; shorts?: number; hair?: number; eye?: number;
  shoes?: number; cap?: number; glasses?: boolean; shortSleeve?: boolean;
  shortsLong?: boolean; longHair?: boolean; hairStyle?: 'long' | 'wavy' | 'pony' | 'bun';
  pose?: 'stand' | 'seated' | 'lounge';
  /** No legs at all — used for seated-on-a-jetski/racer-cockpit figures whose legs would never
   * be seen (legacy `o.walker` is actually the opposite — see `makeHuman`'s `(o.walker?[]:[-1,1])`;
   * kept exactly as legacy named it despite the confusing name: true means "has real jointed legs
   * for walking", false/undefined skips building them). */
  walker?: boolean;
}

export interface Human {
  group: THREE.Group;
  head: THREE.Group;
  hipY: number;
  hands: THREE.Mesh[];
  hair: THREE.Group | null;
  lids: THREE.Mesh[];
  blinkT: number;
  ph: number;
  legs: ReadonlyArray<{ sx: number; hip: THREE.Vector3; th: THREE.Mesh; kn: THREE.Mesh; ca: THREE.Mesh; ft: THREE.Mesh }> | null;
  /** Legacy `h._pose` — the last two hand targets passed to `pose()`, used by Luigi mode to save
   * and restore a resting pose around the beer-holding override. */
  _pose: [THREE.Vector3, THREE.Vector3] | null;
  /** Luigi-mode scratch fields (legacy adds these ad hoc: `h.beer`, `h.sip`, `h.sipT`, `h.sipAmt`). */
  beer: THREE.Group | null;
  sip: number; sipT: number; sipAmt: number;
  pose(a: THREE.Vector3, b: THREE.Vector3): void;
  poseLegs(fl: THREE.Vector3, fr: THREE.Vector3): void;
  update(t: number, boatSpeed?: number): void;
}

/** legacy `makeHuman` (index.html:1244-1356). `womanIndex` replaces the legacy module-level
 * `WOMAN_I++` counter — pass an incrementing counter from the caller (or use `createHumanRegistry`
 * below, which keeps one for you) so repeated bikini figures cycle through `WOMAN_LOOKS` instead
 * of always getting the same look. */
export function makeHuman(o: HumanOptions, womanIndex = 0): Human {
  if (o.bikini) {
    const look = WOMAN_LOOKS[womanIndex % WOMAN_LOOKS.length];
    o = { ...o, hair: look.hair, skin: look.skin, hairStyle: look.hairStyle as HumanOptions['hairStyle'], eye: look.eye, longHair: true };
  }
  const g = new THREE.Group();
  const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);
  const C = (h: number): THREE.Color => new THREE.Color(h);
  const skin = C(o.skin ?? 0xd9a27f), shirt = C(o.shirt ?? 0xffffff), bottom = C(o.shorts ?? 0x334455), hair = C(o.hair ?? 0x3b2a1e);
  const lip = skin.clone().lerp(C(o.bikini ? 0xc24a5c : 0xb3505a), o.bikini ? 0.62 : 0.45);
  const dark = C(0x14161a);
  const pose = o.pose ?? 'stand';
  const hipY = pose === 'seated' ? 0.48 : pose === 'lounge' ? 0.14 : o.bikini ? 0.96 : 0.93;
  const B: MergePart[] = [];
  const add = (geo: THREE.BufferGeometry, m: THREE.Matrix4, c: THREE.Color | null): void => { B.push({ g: geo, m, c }); };
  const cyl = (r0: number, r1: number, seg = 10): THREE.CylinderGeometry => new THREE.CylinderGeometry(r1, r0, 1, seg);
  const sph = (r: number, w = 12, h = 10): THREE.SphereGeometry => new THREE.SphereGeometry(r, w, h);

  // legs: thigh, knee, calf, foot
  for (const sx of o.walker ? [] : [-1, 1]) {
    const hip = V(sx * 0.095, hipY, 0);
    let knee: THREE.Vector3, ankle: THREE.Vector3;
    if (pose === 'seated') { knee = V(sx * 0.1, hipY + 0.03, 0.42); ankle = V(sx * 0.11, 0.09, 0.47); }
    else if (pose === 'lounge') { knee = V(sx * 0.11, hipY + 0.1, 0.44); ankle = V(sx * 0.12, hipY + 0.02, 0.86); }
    else { knee = V(sx * 0.1, 0.5, 0.035); ankle = V(sx * 0.105, 0.085, 0); }
    add(cyl(o.bikini ? 0.096 : 0.085, 0.06), limbMatrix(hip, knee), o.shortsLong ? bottom : skin);
    add(sph(0.06), TM(knee.x, knee.y, knee.z, 0, 0, 0, 1, 1, 1), skin);
    add(cyl(0.058, 0.04), limbMatrix(knee, ankle), skin);
    const fdir = pose === 'lounge' ? V(0, 0.6, 0.4).normalize() : V(0, 0, 1);
    const foot = ankle.clone().addScaledVector(fdir, 0.07).add(V(0, -0.035, 0));
    add(sph(0.05, 10, 8), TM(foot.x, foot.y, foot.z, pose === 'lounge' ? -0.9 : 0, 0, 0, 0.85, 0.62, 2.1), o.shoes ? C(o.shoes) : skin);
  }

  // hips and torso (lathe), clothing painted per height band
  const fem = !!o.bikini;
  add(sph(0.17, 14, 10), TM(0, hipY + 0.05, 0, 0, 0, 0, fem ? 1.12 : 1.03, 0.72, fem ? 0.86 : 0.78), bottom);
  if (fem) {
    for (const sx of [-1, 1]) {
      add(sph(0.1, 14, 12), TM(sx * 0.07, hipY + 0.01, -0.075, 0, 0, 0, 1, 0.95, 0.92), bottom);
      add(sph(0.078, 14, 12), TM(sx * 0.062, hipY + 0.43, 0.082, 0, 0, 0, 1, 0.95, 0.92), bottom);
    }
  }
  const prof = (fem
    ? [[0.168, 0], [0.172, 0.06], [0.14, 0.17], [0.116, 0.25], [0.128, 0.31], [0.148, 0.38], [0.15, 0.44], [0.136, 0.5], [0.085, 0.56], [0.05, 0.6]]
    : [[0.155, 0], [0.165, 0.07], [0.148, 0.18], [0.135, 0.25], [0.15, 0.33], [0.168, 0.41], [0.172, 0.46], [0.155, 0.52], [0.09, 0.57], [0.05, 0.6]]
  ).map((p) => new THREE.Vector2(p[0], p[1]));
  const tg = new THREE.LatheGeometry(prof, fem ? 30 : 18);
  tg.computeVertexNormals();
  const tc: number[] = [], tp = tg.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i);
    let c = o.bikini ? skin : shirt;
    if (y < 0.06) c = bottom;
    if (o.bikini && y > 0.35 && y < 0.45) c = bottom;
    if (o.bikini && y < 0.08) c = bottom;
    tc.push(c.r, c.g, c.b);
  }
  tg.setAttribute('color', new THREE.Float32BufferAttribute(tc, 3));
  add(tg, TM(0, hipY + 0.03, 0, 0, 0, 0, 1, 1, 0.66), null);
  add(cyl(fem ? 0.041 : 0.048, fem ? 0.038 : 0.044, 10), TM(0, hipY + 0.66, 0, 0, 0, 0, 1, 0.11, 1), skin);
  const sleeve = o.bikini ? skin : shirt;
  for (const sx of [-1, 1]) add(sph(fem ? 0.056 : 0.065), TM(sx * (fem ? 0.168 : 0.185), hipY + 0.53, 0, 0, 0, 0, 1, 0.95, 0.9), sleeve);
  const body = new THREE.Mesh(mergeSmooth(B), humanMat);
  body.castShadow = true; body.receiveShadow = true;
  g.add(body);

  // head: skull, jaw, nose, ears, eyes, brows, lips, hair, cap, sunglasses
  const Hd: MergePart[] = [], HP: MergePart[] = [];
  const hadd = (geo: THREE.BufferGeometry, m: THREE.Matrix4, c: THREE.Color | null): void => { Hd.push({ g: geo, m, c }); };
  hadd(sph(0.1, 16, 14), TM(0, 0.02, 0, 0, 0, 0, 0.93, 1.1, 1), skin);
  hadd(sph(0.075, 14, 10), TM(0, -0.045, 0.022, 0, 0, 0, o.bikini ? 0.86 : 1, o.bikini ? 0.78 : 0.82, o.bikini ? 0.95 : 1), skin);
  hadd(new THREE.ConeGeometry(o.bikini ? 0.014 : 0.018, o.bikini ? 0.036 : 0.045, 8), TM(0, 0, 0.1, Math.PI / 2, 0, 0, 1, 1, 1), skin);
  for (const sx of [-1, 1]) {
    hadd(sph(0.024, 8, 6), TM(sx * 0.092, 0.0, -0.005, 0, 0, 0, 0.45, 1, 0.75), skin);
    if (!o.glasses) {
      hadd(sph(0.014, 10, 8), TM(sx * 0.034, 0.022, 0.083, 0, 0, 0, 1, 0.75, 0.6), C(0xf4f1ec));
      if (o.bikini) {
        hadd(sph(0.0085, 10, 8), TM(sx * 0.034, 0.022, 0.089, 0, 0, 0, 1, 1, 0.5), C(o.eye ?? 0x5a3a22));
        hadd(sph(0.0045, 8, 6), TM(sx * 0.034, 0.022, 0.0935, 0, 0, 0, 1, 1, 0.5), dark);
        hadd(sph(0.0018, 6, 4), TM(sx * 0.032, 0.025, 0.095, 0, 0, 0, 1, 1, 1), C(0xffffff));
      } else hadd(sph(0.008, 8, 6), TM(sx * 0.034, 0.022, 0.092, 0, 0, 0, 1, 1, 0.6), dark);
    }
    if (o.bikini) hadd(sph(0.022, 10, 8), TM(sx * 0.052, -0.018, 0.07, 0, 0, 0, 1, 0.7, 0.5), skin.clone().lerp(C(0xe08a8a), 0.22));
    hadd(new THREE.BoxGeometry(o.bikini ? 0.03 : 0.034, o.bikini ? 0.0045 : 0.006, 0.008), TM(sx * 0.036, 0.046, 0.09, 0, 0, -sx * (o.bikini ? 0.2 : 0.12), 1, 1, 1), hair);
    if (o.bikini && !o.glasses) hadd(new THREE.BoxGeometry(0.03, 0.005, 0.006), TM(sx * 0.035, 0.032, 0.094, 0, 0, -sx * 0.15, 1, 1, 1), dark);
  }
  if (o.bikini) {
    for (const sx of [-1, 1]) hadd(sph(0.026, 10, 8), TM(sx * 0.05, 0.0, 0.062, 0, 0, 0, 1, 0.7, 0.8), skin.clone().lerp(C(0xffffff), 0.04));
    hadd(sph(0.024, 10, 8), TM(0, -0.083, 0.058, 0, 0, 0, 1.1, 0.75, 0.85), skin);
    hadd(new THREE.BoxGeometry(0.012, 0.04, 0.012), TM(0, 0.022, 0.094, -0.12, 0, 0, 1, 1, 1), skin);
  }
  if (o.bikini) {
    hadd(sph(0.012, 10, 6), TM(0, -0.047, 0.087, 0, 0, 0, 1.9, 0.6, 0.8), lip);
    hadd(sph(0.012, 10, 6), TM(0, -0.056, 0.086, 0, 0, 0, 1.7, 0.7, 0.8), lip);
  } else hadd(new THREE.BoxGeometry(0.036, 0.009, 0.01), TM(0, -0.052, 0.088, 0, 0, 0, 1, 1, 1), lip);
  if (o.cap) {
    hadd(new THREE.SphereGeometry(0.112, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), TM(0, 0.035, -0.005, 0, 0, 0, 1, 0.9, 1.02), C(o.cap));
    hadd(new THREE.CylinderGeometry(0.09, 0.09, 0.012, 16, 1, false, -Math.PI / 2.4, Math.PI / 1.2), TM(0, 0.04, 0.06, -0.15, 0, 0, 1, 1, 1.25), C(o.cap));
    hadd(sph(0.104, 12, 8), TM(0, 0.0, -0.02, 0, 0, 0, 0.95, 0.6, 0.95), hair);
  } else hadd(new THREE.SphereGeometry(0.108, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.56), TM(0, 0.022, -0.012, -0.12, 0, 0, 0.97, 1.06, 1.07), hair);
  let hairStyleUsed: string | undefined;
  if (o.longHair) {
    const style = o.hairStyle ?? 'long';
    hairStyleUsed = style;
    if (style === 'long' || style === 'wavy') {
      const pts: THREE.Vector2[] = [];
      for (let k = 0; k <= 12; k++) {
        const u = k / 12, y = 0.06 - u * 0.44;
        const r = (0.112 - 0.03 * u * u) + (style === 'wavy' ? Math.sin(u * Math.PI * 4) * 0.008 * u : 0) + 0.01 * Math.sin(u * Math.PI);
        pts.push(new THREE.Vector2(r, y));
      }
      const lg = new THREE.LatheGeometry(pts, 30, Math.PI * 0.3, Math.PI * 1.4);
      HP.push({ g: lg, m: TM(0, 0, -0.012, 0, 0, 0, 1, 1, 0.92), c: hair });
      for (const sx of [-1, 1]) {
        const a = new THREE.Vector3(sx * 0.088, -0.02, 0.035), b = new THREE.Vector3(sx * 0.112, style === 'wavy' ? -0.26 : -0.3, 0.075);
        HP.push({ g: cyl(0.032, 0.012, 10), m: limbMatrix(a, b), c: hair });
      }
      for (let k = 0; k < 7; k++) {
        const a = -0.9 + k * 0.3, r = 0.1;
        HP.push({
          g: cyl(0.014, 0.004, 6),
          m: limbMatrix(new THREE.Vector3(Math.sin(a) * r, -0.05, -Math.cos(a) * r * 0.92), new THREE.Vector3(Math.sin(a) * r * 1.05, -0.41 + 0.03 * Math.sin(k * 2.3), -Math.cos(a) * r * 0.95)),
          c: hair.clone().multiplyScalar(k % 2 ? 1.12 : 0.9),
        });
      }
    } else if (style === 'pony') {
      hadd(sph(0.03, 8, 6), TM(0, 0.035, -0.105, 0, 0, 0, 1, 1, 1), hair);
      HP.push({ g: cyl(0.042, 0.012, 12), m: limbMatrix(new THREE.Vector3(0, 0.03, -0.12), new THREE.Vector3(0, -0.26, -0.16)), c: hair });
    } else if (style === 'bun') {
      hadd(sph(0.05, 12, 10), TM(0, 0.1, -0.075, 0, 0, 0, 1, 0.85, 1), hair);
      hadd(sph(0.03, 8, 6), TM(0, 0.075, -0.06, 0, 0, 0, 1.2, 0.5, 1), hair);
    }
  }
  if (o.glasses) {
    hadd(new THREE.BoxGeometry(0.165, 0.034, 0.014), TM(0, 0.022, 0.095, 0, 0, 0, 1, 1, 1), C(0x0b0d10));
    for (const sx of [-1, 1]) hadd(new THREE.BoxGeometry(0.006, 0.008, 0.11), TM(sx * 0.085, 0.025, 0.04, 0, 0, 0, 1, 1, 1), C(0x0b0d10));
  }
  if (fem) {
    for (const sx of [-1, 1]) {
      add(sph(0.055, 12, 10), TM(sx * 0.085, hipY + 0.575, -0.012, 0, 0, -sx * 0.35, 1.7, 0.55, 1), skin);
      add(cyl(0.0085, 0.0075, 6), limbMatrix(V(sx * 0.022, hipY + 0.54, 0.072), V(sx * 0.13, hipY + 0.556, 0.045)), skin.clone().multiplyScalar(1.03));
      add(sph(0.05, 10, 8), TM(sx * 0.07, hipY + 0.46, -0.095, 0, 0, 0, 1.1, 1.3, 0.45), skin);
    }
  }
  if (fem) {
    const str = (a: THREE.Vector3, b: THREE.Vector3): void => add(cyl(0.006, 0.006, 6), limbMatrix(a, b), bottom);
    for (const sx of [-1, 1]) {
      str(V(sx * 0.07, hipY + 0.47, 0.1), V(sx * 0.035, hipY + 0.64, -0.01));
      str(V(sx * 0.11, hipY + 0.43, 0.06), V(sx * 0.12, hipY + 0.42, -0.08));
      str(V(sx * 0.165, hipY + 0.07, 0.02), V(sx * 0.17, hipY - 0.02, 0.03));
    }
    str(V(-0.12, hipY + 0.42, -0.085), V(0.12, hipY + 0.42, -0.085));
    add(sph(0.008, 6, 4), TM(0, hipY + 0.2, 0.098, 0, 0, 0, 1, 1.4, 0.5), skin.clone().multiplyScalar(0.7));
  }
  const head = new THREE.Group();
  head.position.set(0, hipY + 0.77, 0);
  if (fem) head.scale.setScalar(0.94);
  g.add(head);
  const hm = new THREE.Mesh(mergeSmooth(Hd), humanMat);
  hm.castShadow = true;
  head.add(hm);
  let hairPiv: THREE.Group | null = null;
  if (HP.length) {
    hairPiv = new THREE.Group();
    hairPiv.position.set(0, 0.06, -0.02);
    head.add(hairPiv);
    const hmm = new THREE.Mesh(mergeSmooth(HP), humanMat);
    hmm.position.set(0, -0.06, 0.02);
    hmm.castShadow = true;
    hairPiv.add(hmm);
  }
  const lids: THREE.Mesh[] = [];
  if (o.bikini && !o.glasses) {
    for (const sx of [-1, 1]) {
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.0155, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), hmat(o.skin ?? 0xd9a27f));
      l.position.set(sx * 0.034, 0.024, 0.084);
      l.rotation.x = -0.25;
      l.scale.set(1, 0.15, 0.8);
      head.add(l);
      lids.push(l);
    }
  }

  // jointed arms solved with two-bone IK
  const sleeveMat = hmat(o.bikini ? (o.skin ?? 0xd9a27f) : (o.shirt ?? 0xffffff)), skinMat = hmat(o.skin ?? 0xd9a27f);
  const mk = (geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; g.add(m); return m; };
  const fA = o.bikini ? 0.85 : 1, sg = o.bikini ? 14 : 10;
  const arms = ([-1, 1] as const).map((sx) => ({
    sx, sh: V(sx * (o.bikini ? 0.175 : 0.19), hipY + 0.53, 0),
    up: mk(cyl(0.046 * fA, 0.038 * fA, sg), sleeveMat),
    lo: mk(cyl(0.036 * fA, 0.029 * fA, sg), o.shortSleeve || o.bikini ? skinMat : sleeveMat),
    el: mk(sph(0.038 * fA, 10, 8), sleeveMat),
    hd: mk(sph(0.042 * fA, 10, 8), skinMat),
  }));
  const L1 = 0.29, L2 = 0.27;

  const legs = o.walker ? ([-1, 1] as const).map((sx) => ({
    sx, hip: V(sx * 0.095, hipY, 0),
    th: mk(cyl(o.bikini ? 0.096 : 0.085, 0.06), o.shortsLong ? hmat(o.shorts ?? 0x334455) : skinMat),
    kn: mk(sph(o.bikini ? 0.05 : 0.058, 10, 8), skinMat),
    ca: mk(o.bikini ? cyl(0.06, 0.032, 14) : cyl(0.058, 0.04), skinMat),
    ft: mk(o.bikini ? sph(0.042, 10, 8) : sph(0.05, 10, 8), o.shoes ? hmat(o.shoes) : skinMat),
  })) : null;

  const h: Human = {
    group: g, head, hipY, hands: arms.map((a) => a.hd), hair: hairPiv, lids, blinkT: 2 + Math.random() * 2, ph: Math.random() * 10,
    legs, _pose: null, beer: null, sip: 0, sipT: 0, sipAmt: 0,
    poseLegs(fl: THREE.Vector3, fr: THREE.Vector3): void {
      if (!legs) return;
      [fl, fr].forEach((tgt, i) => {
        const Lg = legs[i];
        const r = solveIK(Lg.hip, tgt, 0.43, 0.42, V(0, 0.1, 1));
        setLimb(Lg.th, Lg.hip, r.E); Lg.kn.position.copy(r.E); setLimb(Lg.ca, r.E, r.T);
        Lg.ft.position.copy(r.T).add(V(0, -0.035, 0.07)); Lg.ft.scale.set(0.85, 0.62, 2.1);
      });
    },
    pose(a: THREE.Vector3, b: THREE.Vector3): void {
      h._pose = [a.clone(), b.clone()];
      [a, b].forEach((tgt, i) => {
        const A = arms[i], S = A.sh;
        const d = _e1.subVectors(tgt, S);
        const len = Math.min(d.length(), L1 + L2 - 0.003) || 0.01;
        const dir = d.normalize();
        const a1 = (L1 * L1 - L2 * L2 + len * len) / (2 * len), hh = Math.sqrt(Math.max(0, L1 * L1 - a1 * a1));
        const pole = _e2.set(A.sx * 0.45, -0.8, -0.55);
        pole.addScaledVector(dir, -pole.dot(dir)).normalize();
        const E = S.clone().addScaledVector(dir, a1).addScaledVector(pole, hh), Hn = S.clone().addScaledVector(dir, len);
        setLimb(A.up, S, E); setLimb(A.lo, E, Hn); A.el.position.copy(E);
        A.hd.position.copy(Hn).addScaledVector(dir, 0.035);
        A.hd.quaternion.setFromUnitVectors(_up, dir);
        A.hd.scale.set(0.95, 1.9, 0.6);
      });
    },
    update(t: number, boatSpeed = 0): void {
      head.rotation.y = Math.sin(t * 0.27 + h.ph) * 0.35 + Math.sin(t * 0.71 + h.ph * 2) * 0.1;
      head.rotation.x = Math.sin(t * 0.4 + h.ph) * 0.05;
      if (lids.length) {
        h.blinkT -= 1 / 60;
        const b = h.blinkT < 0 ? Math.sin(Math.min(1, -h.blinkT / 0.14) * Math.PI) : 0;
        if (h.blinkT < -0.14) h.blinkT = 2 + Math.random() * 3;
        lids.forEach((l) => { l.scale.y = 0.15 + 0.85 * b; });
      }
      if (hairPiv) {
        // legacy `h.update` (index.html:1348): hair whips back and blows in the wind as a
        // function of how fast the *boat* is moving through the air, not this person's own
        // motion — legacy read the module-global `boat.speed`; the caller passes it in.
        const w = Math.min(1, Math.abs(boatSpeed) / 22);
        hairPiv.rotation.x = -w * 0.45 + Math.sin(t * (1.6 + w * 6) + h.ph) * (0.03 + w * 0.07);
        hairPiv.rotation.z = Math.sin(t * 1.1 + h.ph * 1.7) * (0.03 + w * 0.05);
      }
      if (o.bikini) g.scale.y = 1 + Math.sin(t * 1.5 + h.ph) * 0.004;
    },
  };
  if (o.bikini) {
    arms.forEach((A) => {
      const th = new THREE.Mesh(new THREE.SphereGeometry(0.012, 8, 6), skinMat);
      th.position.set(A.sx * 0.022, -0.004, 0.012);
      th.scale.set(1, 1.8, 1);
      A.hd.add(th);
    });
  }
  h.poseLegs(V(-0.105, 0.085, 0), V(0.105, 0.085, 0));
  if (pose === 'seated') h.pose(V(-0.16, hipY + 0.08, 0.34), V(0.16, hipY + 0.08, 0.34));
  else if (pose === 'lounge') h.pose(V(-0.3, hipY + 0.08, 0.05), V(0.3, hipY + 0.08, 0.05));
  else h.pose(V(-0.24, hipY + 0.02, 0.05), V(0.24, hipY + 0.02, 0.05));
  void hairStyleUsed;
  return h;
}

/** legacy's inline two-bone IK solve, factored out (it's duplicated verbatim as `h.poseLegs`'s
 * local `solve` and `h.pose`'s inline arm math in legacy — unified here for the leg case only;
 * arms keep their own copy above since the pole-vector differs). */
function solveIK(S: THREE.Vector3, tgt: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3): { E: THREE.Vector3; T: THREE.Vector3 } {
  const d = new THREE.Vector3().subVectors(tgt, S);
  const len = Math.min(d.length(), l1 + l2 - 0.003) || 0.01;
  const dir = d.normalize().clone();
  const a1 = (l1 * l1 - l2 * l2 + len * len) / (2 * len), hh = Math.sqrt(Math.max(0, l1 * l1 - a1 * a1));
  const pp = pole.clone();
  pp.addScaledVector(dir, -pp.dot(dir)).normalize();
  return { E: S.clone().addScaledVector(dir, a1).addScaledVector(pp, hh), T: S.clone().addScaledVector(dir, len) };
}

/** legacy's module-level `HUMANS`/`WOMAN_I`/`updateHumans` (index.html:1231, 1243, 1357), wrapped
 * in a factory instead of module state so independent scenes (e.g. a Playwright test harness and
 * the real game) never share a `WOMAN_I` cycle or a culling list. */
export interface HumanRegistry {
  makeHuman(o: HumanOptions): Human;
  /** legacy `updateHumans` (index.html:1357) — distance-culled: only animates humans within 160m
   * of `cameraPos`. `boatSpeed` drives the hair-whip-in-the-wind effect (legacy read the
   * module-global `boat.speed` directly; this registry has no boat of its own, so the caller —
   * whichever boat a given human is riding on — passes it in). */
  updateHumans(t: number, cameraPos: { x: number; y: number; z: number }, boatSpeed?: number): void;
}

export function createHumanRegistry(): HumanRegistry {
  const humans: Human[] = [];
  let womanI = 0;
  const campos = new THREE.Vector3();
  const worldpos = new THREE.Vector3();
  return {
    makeHuman(o: HumanOptions): Human {
      const h = makeHuman(o, o.bikini ? womanI++ : womanI);
      humans.push(h);
      return h;
    },
    updateHumans(t: number, cameraPos: { x: number; y: number; z: number }, boatSpeed = 0): void {
      campos.set(cameraPos.x, cameraPos.y, cameraPos.z);
      for (const h of humans) {
        if (!h.group.parent) continue;
        h.group.getWorldPosition(worldpos);
        if (worldpos.distanceToSquared(campos) < 160 * 160) h.update(t, boatSpeed);
      }
    },
  };
}
