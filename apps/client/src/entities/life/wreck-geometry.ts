/**
 * Procedural wreck hulls: one merged, vertex-coloured BufferGeometry per hull section, at two
 * levels of detail.
 *
 * Everything is built in a wreck's local frame - origin on the seabed at the hull's centre, bow
 * toward -z (the boat group convention, so `group.rotation.y = heading` points it where
 * shared/world/wrecks.ts says), +x to starboard, +y up. A snapped wreck is two sections that meet
 * at u = 0 (the break plane); the entity positions the stern section by the shared `gap`/
 * `breakYaw`, so the geometry and the fish hold points agree about where the steel is.
 *
 * **Detail 0 is the dark mass**, detail 1 is what it turns out to be. Underwater visibility is
 * 10-30 m and a freighter is 85-120 m long, so most of the time you see a wreck as a silhouette
 * through blue-black water long before any plating resolves. Detail 0 is therefore only the lofted
 * hull and the big boxes that make the silhouette (deckhouse, funnel, wings, tail): ~1/6 the
 * triangles, and it is what is drawn from 100 m out. Detail 1 adds the things you read up close -
 * hatch coamings, derricks, masts, rails, torn plating and ribs, engines and props.
 *
 * Colour is baked per vertex (rust and faded paint by position noise, marine growth on up-facing
 * surfaces) rather than textured: one material, no UVs, and `fog_fragment`'s per-channel
 * extinction (world/underwater/fog-override.ts) does the rest - red goes first, so a rust-brown
 * hull is near black by 15 m, which is the correct "dark mass".
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Wreck, WreckKind } from '@keysrun/shared/world/wrecks';

type RGB = readonly [number, number, number];

/** Deterministic 0..1 from three numbers - cosmetic variation only, position-derived so a rebuild
 * is identical. */
const hash3 = (x: number, y: number, z: number): number => {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
};

const RUST: RGB = [0.56, 0.32, 0.18];
const RUST_DK: RGB = [0.28, 0.17, 0.12];
const PAINT_RED: RGB = [0.56, 0.17, 0.12];
const PAINT_GREY: RGB = [0.68, 0.70, 0.68];
const ALUM: RGB = [0.55, 0.57, 0.58];
const GROWTH: RGB = [0.30, 0.31, 0.17];
const SAND: RGB = [0.62, 0.55, 0.38];
const ENC_PALE: RGB = [0.78, 0.78, 0.68];
const ENC_ALGAE: RGB = [0.42, 0.64, 0.38];
const ENC_SPONGE: RGB = [0.92, 0.52, 0.22];
const ENC_YELLOW: RGB = [0.88, 0.76, 0.30];
/** Treasure-container palette (buildContainer, below). The water takes the HUE off gold and
 * silver like everything else - verified in a screenshot at 14 m, where the hasp is a pale patch
 * and not a yellow one - but not their brightness, and bright is what carries through blue-green
 * water. They are on a container for that reason: a light-valued edge in a world of rust and
 * algae is the cue that says "openable" rather than "debris". */
const GOLD: RGB = [1.00, 0.82, 0.30];
const SILVER: RGB = [0.88, 0.90, 0.92];
const WOOD: RGB = [0.30, 0.22, 0.14];
/** Ballast stone and corroded coin-mass: deliberately darker than SAND so the loose silver on top
 * of a spill has something to stand against. A sand-coloured mound with sand-coloured coins on it
 * photographed as a blob of dough. */
const BALLAST: RGB = [0.34, 0.31, 0.27];
const VERDIGRIS: RGB = [0.24, 0.52, 0.45];
/** The inside of an emptied box. Near-black on purpose: at a diver's eye level the dark well
 * where the contents were is the only "already looted" signal that survives the fog. */
const DARK: RGB = [0.05, 0.05, 0.06];

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nm = new THREE.Matrix3();

/** Collects transformed parts, colours them, and merges once. */
class Bag {
  private parts: THREE.BufferGeometry[] = [];

  /**
   * Offset added to a vertex before the colour noise and the encrustation patches are hashed off
   * it. Everything in this file is painted from its position in the wreck's frame, which is what
   * makes a rebuild identical and the growth continuous across merged parts - but it also means
   * twenty treasure containers all built at the local origin come out the same colour. Giving
   * each one its own colour origin (never its own geometry transform) varies the growth without
   * moving anything.
   */
  constructor(
    private readonly co: readonly [number, number, number] = [0, 0, 0],
    /**
     * Scales the encrustation patch cells, which are ~3 m across because that is the size of a
     * sponge or coralline patch on a 100 m hull. A 0.9 m strongbox is smaller than one cell, so
     * at 1 the whole box comes out one flat colour - which is exactly how the first screenshots
     * of it looked. Containers pass ~0.08 (24 cm cells) and get the mottling the hull gets, at
     * their own scale.
     */
    private readonly ps: number = 1,
  ) {}

  /** Adds `g` transformed by `m`, painted `base` with position noise and growth on up-facing faces. */
  add(g: THREE.BufferGeometry, m: THREE.Matrix4, base: RGB, growth = 0.45): void {
    const ng = g.index ? g.toNonIndexed() : g.clone();
    ng.deleteAttribute('uv');
    ng.applyMatrix4(m);
    const pos = ng.attributes.position as THREE.BufferAttribute;
    const nor = ng.attributes.normal as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    _nm.getNormalMatrix(m);
    for (let i = 0; i < pos.count; i++) {
      _v.fromBufferAttribute(pos, i);
      _n.fromBufferAttribute(nor, i);
      _v.x += this.co[0]; _v.y += this.co[1]; _v.z += this.co[2];
      const n1 = hash3(Math.round(_v.x * 1.3), Math.round(_v.y * 1.3), Math.round(_v.z * 1.3));
      const n2 = hash3(Math.round(_v.z * 0.7), Math.round(_v.x * 0.7), Math.round(_v.y * 0.7));
      const k = 0.72 + 0.56 * n1;
      let r = base[0] * k, gg = base[1] * k, b = base[2] * k;
      const up = Math.max(0, _n.y);
      const gk = growth * up * (0.4 + 0.6 * n2);
      r += (GROWTH[0] * (0.7 + n2 * 0.6) - r) * gk;
      gg += (GROWTH[1] * (0.7 + n2 * 0.6) - gg) * gk;
      b += (GROWTH[2] * (0.7 + n2 * 0.6) - b) * gk;
      // Encrustation: sponge, algae and coralline crust grow in patches ~3 m across, and they are the
      // bright part of a wreck - rust goes black with the red extinction by 10 m, but pale growth
      // survives it, which is what makes a hull read as a *wreck* rather than a dark slab. Patch
      // cells are position-hashed, so a rebuild is identical.
      const pc = hash3(Math.floor(_v.x / (3 * this.ps)), Math.floor(_v.y / (2.4 * this.ps)), Math.floor(_v.z / (3 * this.ps)));
      if (pc > 0.5) {
        const kind = hash3(Math.floor(_v.z / 3), Math.floor(_v.x / 3), 11.3);
        const e = Math.min(1, (pc - 0.5) / 0.25) * 0.85 * (0.55 + 0.45 * n2);
        const c = kind < 0.4 ? ENC_PALE : kind < 0.7 ? ENC_ALGAE : kind < 0.88 ? ENC_SPONGE : ENC_YELLOW;
        r += (c[0] - r) * e; gg += (c[1] - gg) * e; b += (c[2] - b) * e;
      }
      // silt settled on the very top of the structure, thinning with height off the bottom
      const silt = up * up * 0.25 * Math.max(0, 1 - _v.y / 14);
      r += (SAND[0] - r) * silt; gg += (SAND[1] - gg) * silt; b += (SAND[2] - b) * silt;
      col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b;
    }
    ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(ng);
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, base: RGB, ry = 0, rx = 0, rz = 0): void {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(1, 1, 1));
    this.add(new THREE.BoxGeometry(w, h, d), m, base);
  }

  /** A cylinder from `a` to `b`. */
  beam(a: THREE.Vector3, b: THREE.Vector3, r: number, base: RGB, seg = 6): void {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length() || 0.001;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.divideScalar(len));
    const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
    this.add(new THREE.CylinderGeometry(r, r, len, seg, 1), m, base, 0.3);
  }

  /** Raw triangles (positions xyz triples) painted `base`. */
  tris(p: number[], base: RGB): void {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.computeVertexNormals();
    this.add(g, new THREE.Matrix4(), base);
  }

  build(): THREE.BufferGeometry | null {
    if (this.parts.length === 0) return null;
    const g = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    return g;
  }
}

const V3 = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

interface HullProfile {
  /** Hull body height (m) at midships, and the half-beam at station u (-0.5 stern .. 0.5 bow). */
  hh: number;
  half: (u: number) => number;
  /** Deck height at u (sheer): the bow rises. */
  deck: (u: number) => number;
  /** Fraction of the beam the flat bottom spans (barge ~0.9, tug ~0.4). */
  flat: number;
}

const smooth = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function profileFor(kind: WreckKind, L: number, B: number, H: number): HullProfile {
  void L;
  if (kind === 'barge') {
    return {
      hh: H, flat: 0.92,
      half: (u) => (B / 2) * (Math.abs(u) < 0.44 ? 1 : Math.max(0.55, 1 - (Math.abs(u) - 0.44) * 6)),
      deck: () => H,
    };
  }
  if (kind === 'tug') {
    return {
      hh: H * 0.5, flat: 0.35,
      half: (u) => (B / 2) * Math.max(0.08, Math.pow(Math.max(0, 1 - Math.pow(Math.abs(u) * 2, 3.2)), 0.5)),
      deck: (u) => H * 0.5 * (1 + 0.22 * smooth(0.1, 0.5, u)),
    };
  }
  // freighter: parallel midbody, fine bow, blunt counter stern
  return {
    hh: H * 0.56, flat: 0.55,
    half: (u) => (B / 2) * (u > 0.28 ? Math.max(0.05, Math.pow((0.5 - u) / 0.22, 0.6)) : u < -0.36 ? Math.max(0.35, 1 - (-0.36 - u) / 0.14 * 0.6) : 1),
    deck: (u) => H * 0.56 * (1 + 0.2 * smooth(0.2, 0.5, u)),
  };
}

/** Lofts the hull between stations u0..u1 (u1 > u0). `open0`/`open1` leave that end uncapped (the
 * snapped ends). Holes punched through the upper topsides by hash show the dark interior. */
function loft(bag: Bag, prof: HullProfile, L: number, u0: number, u1: number, detail: number, holes: number, seedKey: number): void {
  const N = detail ? Math.max(3, Math.round((u1 - u0) * 26)) : Math.max(2, Math.round((u1 - u0) * 8));
  // 12-point section: 0 keel centre, 1-5 up the starboard side to the deck edge, 6 deck centre,
  // 7-11 down the port side (mirrored), closing back to the keel. x is starboard.
  const ring = (u: number): Array<[number, number]> => {
    const b = prof.half(u), dk = prof.deck(u), hh = prof.hh, fb = b * prof.flat;
    const r: Array<[number, number]> = [[fb, 0], [b * 0.97, hh * 0.18], [b, hh * 0.45], [b, dk * 0.98], [b * 0.97, dk]];
    return [[0, 0], ...r, [0, dk], ...r.map(([x, y]) => [-x, y] as [number, number]).reverse()];
  };
  const pt = (rg: Array<[number, number]>, i: number, z: number): number[] => [rg[i][0], rg[i][1], z];
  const rustSide: number[] = [], paintSide: number[] = [], deckTris: number[] = [];
  for (let s = 0; s < N; s++) {
    const ua = u0 + (u1 - u0) * (s / N), ub = u0 + (u1 - u0) * ((s + 1) / N);
    const ra = ring(ua), rb = ring(ub), za = -ua * L, zb = -ub * L;
    const M = ra.length;
    for (let i = 0; i < M; i++) {
      const j = (i + 1) % M;
      // topside plating (right 3, left 8) is where a rotted hull opens up and shows its hold
      if ((i === 3 || i === 8) && holes > 0 && hash3(s * 3.1 + seedKey, i * 1.7, N) < holes) continue;
      const A = pt(ra, i, za), Bq = pt(ra, j, za), C = pt(rb, j, zb), D = pt(rb, i, zb);
      const target = (i === 5 || i === 6) ? deckTris : (i <= 2 || i >= 9) ? paintSide : rustSide;
      target.push(...A, ...Bq, ...C, ...A, ...C, ...D);
    }
  }
  bag.tris(paintSide, PAINT_RED);
  bag.tris(rustSide, RUST);
  bag.tris(deckTris, RUST_DK);
}

/** Frames (ribs) sticking out of a torn end at u, as thin boxes up the topsides: the skeleton you
 * see where a hull has been broken open. */
function ribs(bag: Bag, prof: HullProfile, L: number, u: number, n: number, key: number): void {
  const b = prof.half(u), dk = prof.deck(u), z = -u * L;
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1;
    const f = hash3(i, key, 3.3);
    const hgt = dk * (0.35 + 0.65 * f);
    bag.box(0.22, hgt, 0.22, side * b * (0.55 + 0.45 * hash3(i, key, 9.1)), hgt / 2 + dk * 0.05, z + (hash3(i, key, 5.5) - 0.5) * 1.2, RUST, 0, (hash3(i, key, 1.1) - 0.5) * 0.5, side * (0.1 + 0.25 * hash3(i, key, 2.2)));
  }
}

function freighterSection(bag: Bag, w: Wreck, u0: number, u1: number, detail: number): void {
  const L = w.len, B = w.beam, H = w.height;
  const prof = profileFor('freighter', L, B, H);
  loft(bag, prof, L, u0, u1, detail, detail ? 0.1 : 0, w.index * 7 + (u0 < 0 ? 1 : 0));
  const dkAt = (u: number): number => prof.deck(u);
  const hasStern = u0 < -0.3, hasBow = u1 > 0.3;
  if (hasStern) {
    // deckhouse aft: the dark mass's tallest part; funnel behind it
    const z = -(-0.3) * L, dk = dkAt(-0.3);
    bag.box(B * 0.62, H * 0.36, L * 0.13, 0, dk + H * 0.18, z, PAINT_GREY);
    bag.box(B * 0.5, H * 0.16, L * 0.09, 0, dk + H * 0.44, z - L * 0.01, PAINT_GREY);
    bag.beam(V3(0, dk + H * 0.3, z + L * 0.045), V3(0, dk + H * 0.82, z + L * 0.075), B * 0.1, RUST_DK, 8);
    if (detail) {
      bag.beam(V3(B * 0.2, dk + H * 0.5, z), V3(B * 0.2, dk + H * 1.0, z - 1), 0.22, RUST, 5);
      bag.box(B * 0.55, 0.12, 0.12, 0, dk + H * 0.95, z - 1, RUST, 0, 0, 0.35);
      for (let i = -2; i <= 2; i++) bag.box(1.2, 0.8, 0.12, i * B * 0.12, dk + H * 0.3, z - L * 0.066, RUST_DK);
    }
  }
  if (hasBow) {
    const z = -0.34 * L, dk = dkAt(0.34);
    bag.box(B * 0.5, H * 0.14, L * 0.06, 0, dk + H * 0.07, z, PAINT_GREY);
    if (detail) { bag.beam(V3(0, dk, z - 3), V3(0, dk + H * 0.85, z - 3.4), 0.28, RUST, 6); bag.box(B * 0.25, 0.12, 0.12, 0, dk + H * 0.7, z - 3.3, RUST, 0, 0, -0.2); }
  }
  {
    // hatch coamings along the cargo deck, some stove in
    for (let i = 0; i < 3; i++) {
      const u = 0.18 - i * 0.16;
      if (u < u0 + 0.03 || u > u1 - 0.03) continue;
      const dk = dkAt(u);
      bag.box(B * 0.5, H * 0.07, L * 0.085, 0, dk + H * 0.035, -u * L, RUST_DK, 0, 0, (i - 1) * 0.04);
    }
  }
  if (detail) {
    for (let i = 0; i < 2; i++) {
      const u = 0.2 - i * 0.3;
      if (u < u0 + 0.03 || u > u1 - 0.03) continue;
      const dk = dkAt(u), z = -u * L;
      bag.beam(V3(0, dk, z), V3(0, dk + H * 0.6, z), 0.2, RUST, 5);
      const fallen = i === 1;
      bag.beam(V3(0, dk + H * 0.55, z), fallen ? V3(B * 0.7, dk + H * 0.05, z + 6) : V3(B * 0.5, dk + H * 0.7, z + L * 0.12), 0.1, RUST, 4);
    }
    // vertical stiffeners down the topsides every ~3 m: relief the sun can rake across, so a hull
    // reads as plated steel and not a smooth slab; a few are missing where the plating has gone
    const ns = Math.round((u1 - u0) * L / 3);
    for (let k = 0; k < ns; k++) {
      const u = u0 + (u1 - u0) * (k + 0.5) / ns;
      const b = prof.half(u), dk = dkAt(u);
      for (const sd of [-1, 1]) {
        if (hash3(k, sd, w.index + 5) < 0.2) continue;
        bag.box(0.16, dk * 0.8, 0.3, sd * (b + 0.05), dk * 0.5, -u * L, RUST_DK);
      }
    }
    // rails along the sides, broken by gaps
    for (let s = -1; s <= 1; s += 2) {
      for (let k = 0; k < 14; k++) {
        const u = u0 + (u1 - u0) * (k + 0.5) / 14;
        if (hash3(k, s, w.index) < 0.35) continue;
        const dk = dkAt(u), b = prof.half(u);
        bag.box(0.06, 0.9, L * (u1 - u0) / 14 * 0.9, s * b * 0.98, dk + 0.45, -u * L, RUST, 0, 0, s * (hash3(k, 2, 7) - 0.4) * 0.5);
      }
    }
  }
}

function tugSection(bag: Bag, w: Wreck, detail: number): void {
  const L = w.len, B = w.beam, H = w.height;
  const prof = profileFor('tug', L, B, H);
  loft(bag, prof, L, -0.5, 0.5, detail, detail ? 0.06 : 0, w.index);
  const dk = prof.deck(0);
  bag.box(B * 0.72, H * 0.42, L * 0.24, 0, dk + H * 0.21, -0.1 * L, PAINT_GREY);
  bag.box(B * 0.78, H * 0.1, L * 0.27, 0, dk + H * 0.47, -0.1 * L, PAINT_GREY);
  bag.beam(V3(0, dk + H * 0.4, 0.14 * L), V3(0, dk + H * 0.95, 0.15 * L), B * 0.16, RUST_DK, 8);
  if (detail) {
    bag.box(B * 0.6, 0.2, 0.6, 0, dk + 0.1, -0.34 * L, RUST_DK);
    bag.beam(V3(B * 0.1, dk, 0.3 * L), V3(B * 0.1, dk + 1.2, 0.3 * L), 0.18, RUST, 5);
    for (let i = 0; i < 4; i++) {
      const t = new THREE.Matrix4().compose(V3(B * 0.5 * (i % 2 ? 1 : -1), dk * 0.7, (-0.2 + i * 0.12) * L), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)), V3(1, 1, 1));
      bag.add(new THREE.TorusGeometry(0.45, 0.16, 5, 9), t, RUST_DK, 0.2);
    }
  }
}

function bargeSection(bag: Bag, w: Wreck, detail: number): void {
  const L = w.len, B = w.beam, H = w.height;
  const prof = profileFor('barge', L, B, H);
  loft(bag, prof, L, -0.5, 0.5, detail, detail ? 0.18 : 0, w.index);
  // a spilled cargo of aggregate heaped in the hold
  const heap = new THREE.Matrix4().compose(V3(0, H * 0.85, -0.05 * L), new THREE.Quaternion(), V3(B * 0.42, H * 0.5, L * 0.28));
  bag.add(new THREE.IcosahedronGeometry(1, detail ? 1 : 0), heap, SAND, 0.2);
  bag.box(B * 0.5, H * 0.9, L * 0.1, 0, H + H * 0.45, 0.36 * L, PAINT_GREY);
  if (detail) {
    bag.box(B * 0.04, H * 1.5, L * 0.8, B / 2, H * 0.75, 0, RUST, 0, 0, 0.0); // coaming remnants down the starboard side
    bag.beam(V3(-B * 0.3, H, -0.38 * L), V3(-B * 0.3, H + 2.2, -0.38 * L), 0.15, RUST, 5);
  }
}

function planeSection(bag: Bag, w: Wreck, tail: boolean, detail: number): void {
  const L = w.len, span = w.beam;
  const R = 1.35;
  const seg = detail ? 10 : 6;
  if (!tail) {
    // fuselage nose..break: a cylinder with a rounded nose
    const len = L * 0.58, z = -(len / 2) + 0.5;
    const m = new THREE.Matrix4().compose(V3(0, R + 0.4, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), V3(1, 1, 1));
    bag.add(new THREE.CylinderGeometry(R, R * 0.96, len, seg, 1, true), m, ALUM, 0.5);
    const nose = new THREE.Matrix4().compose(V3(0, R + 0.4, -len + 0.4), new THREE.Quaternion(), V3(R, R * 0.95, R * 1.5));
    bag.add(new THREE.SphereGeometry(1, seg, 5, 0, Math.PI * 2, 0, Math.PI), nose, ALUM, 0.5);
    // wings: root thick, tapering; the port one is snapped off short
    for (const s of [-1, 1]) {
      const reach = s < 0 ? span * 0.2 : span * 0.5;
      const wing = new THREE.Matrix4().compose(V3(s * (reach / 2 + R * 0.6), R * 0.9 + 0.2, z * 0.4), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, s * 0.12, s * -0.05)), V3(1, 1, 1));
      bag.add(new THREE.BoxGeometry(reach, 0.38, 4.2), wing, ALUM, 0.55);
      if (s > 0 || detail) {
        const ex = s * (Math.min(reach, span * 0.3) * 0.8 + R);
        const eng = new THREE.Matrix4().compose(V3(ex, R * 0.9 + 0.25, z * 0.4 - 2.4), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), V3(1, 1, 1));
        bag.add(new THREE.CylinderGeometry(0.62, 0.55, 2.6, 8, 1), eng, RUST_DK, 0.4);
        if (detail) for (let k = 0; k < 3; k++) bag.box(0.18, 2.2, 0.08, ex, R * 0.9 + 0.25, z * 0.4 - 3.9, RUST, 0, 0, k * 2.1 + 0.6);
      }
    }
  } else {
    // tail section: tapering rear fuselage with fin and stabilisers, lying where it fell
    const len = L * 0.38;
    const m = new THREE.Matrix4().compose(V3(0, R * 0.8 + 0.3, len / 2), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), V3(1, 1, 1));
    bag.add(new THREE.CylinderGeometry(R * 0.96, R * 0.35, len, seg, 1, true), m, ALUM, 0.5);
    bag.box(0.2, R * 2.3, 2.4, 0, R * 1.9, len * 0.88, ALUM, 0, 0.25, 0.5);
    bag.box(span * 0.28, 0.22, 1.7, 0, R * 0.9, len * 0.9, ALUM, 0.05);
  }
}

/** Builds one section's merged geometry. `part`: 0 = the whole wreck or the bow section of a
 * snapped one, 1 = the stern section of a snapped one. */
export function buildSection(w: Wreck, part: 0 | 1, detail: 0 | 1): THREE.BufferGeometry | null {
  const bag = new Bag();
  const split = w.broken;
  const prof = w.kind === 'freighter' ? profileFor('freighter', w.len, w.beam, w.height) : null;
  switch (w.kind) {
    case 'freighter': {
      const [u0, u1] = !split ? [-0.5, 0.5] : part === 0 ? [0, 0.5] : [-0.5, 0];
      freighterSection(bag, w, u0, u1, detail);
      if (split && prof) ribs(bag, prof, w.len, 0, detail ? 9 : 0, w.index + part * 13);
      break;
    }
    case 'tug': tugSection(bag, w, detail); break;
    case 'barge': bargeSection(bag, w, detail); break;
    case 'plane': planeSection(bag, w, part === 1, detail); break;
  }
  return bag.build();
}

/** Scattered plates, pipe and wreckage on the seabed around a wreck, in the root's local frame.
 * `groundY(lx,lz)` returns the seabed height there relative to the root origin. */
export function buildDebris(w: Wreck, groundY: (lx: number, lz: number) => number): THREE.BufferGeometry | null {
  const bag = new Bag();
  const n = Math.round(6 + w.mass * 11);
  const reachX = w.beam * 0.5 + 8 + w.len * 0.05, reachZ = w.len * 0.5 + w.gap + 8;
  for (let i = 0; i < n; i++) {
    const a = hash3(i, w.index, 1) , b = hash3(i, w.index, 2), c = hash3(i, w.index, 3), d = hash3(i, w.index, 4);
    const lx = (a * 2 - 1) * reachX * (0.6 + 0.8 * b), lz = (b * 2 - 1) * reachZ * (0.5 + 0.5 * a);
    const sz = 0.6 + 3.2 * c * c;
    const y = groundY(lx, lz) + 0.12;
    if (d < 0.55) bag.box(sz * 1.6, 0.14 + 0.1 * c, sz, lx, y, lz, i % 3 ? RUST : RUST_DK, a * 6.28, (b - 0.5) * 0.3, (c - 0.5) * 0.3);
    else if (d < 0.85) bag.beam(V3(lx, y + 0.1, lz), V3(lx + Math.cos(a * 6.28) * sz * 2, y + 0.2, lz + Math.sin(a * 6.28) * sz * 2), 0.1 + 0.08 * c, RUST, 5);
    else bag.box(sz * 0.8, sz * 0.5, sz * 0.8, lx, y + sz * 0.2, lz, RUST_DK, a * 6.28);
  }
  return bag.build();
}

/* ------------------------------------------------------------------------------------------ *
 * Treasure containers (entities/life/wreck-treasure.ts; rules in @keysrun/shared/sim/treasure)
 * ------------------------------------------------------------------------------------------ */

/**
 * One container, in its own local frame: origin on the sand at its base centre, +y up, +z toward
 * the front (the lid hinges at the back). The caller yaws it and sinks it into the seabed.
 *
 * Built here rather than in a file of its own so it shares `Bag` with the hulls: the same
 * per-vertex rust, silt, marine growth and coralline encrustation, from the same position hashes.
 * A box beside a wreck painted by different code would read as a prop dropped next to the set,
 * and "looks like it has been down there a century" is the whole brief.
 *
 * `open` is a SECOND geometry, not a transform of the first: an opened strongbox is a different
 * object (lid thrown back, nothing inside, no gold left on the banding to catch the light). Both
 * are built when a wreck comes into range and the entity toggles `visible` between them, because
 * a container is ~150 triangles and that is cheaper than rebuilding and disposing one the instant
 * the player opens it, mid-dive.
 *
 * `key` only varies the colour noise (see `Bag`'s `co`), so two strongboxes on the same wreck are
 * encrusted differently; it never moves a vertex.
 */
export function buildContainer(kind: 'strongbox' | 'coins' | 'crate' | 'ammocan', open: boolean, key: number): THREE.BufferGeometry | null {
  // y is left at 0 in the colour origin: `Bag`'s silt term fades with height off the bottom, and
  // shifting a 0.5 m box up a nominal 30 m would silt it like a seabed plate.
  const bag = new Bag([key * 37.1, 0, key * 61.7], 0.08);
  const h = (a: number): number => hash3(key, a, 5.1);
  switch (kind) {
    case 'strongbox': {
      // A purser's box: 0.95 m of oak and iron, the oak long gone soft, the straps still there.
      bag.box(0.92, 0.40, 0.60, 0, 0.20, 0, WOOD, 0, 0, 0.02);
      for (const sx of [-0.30, 0, 0.30]) bag.box(0.07, 0.44, 0.63, sx, 0.21, 0, RUST_DK);
      bag.box(0.95, 0.05, 0.63, 0, 0.42, 0, RUST, 0, 0, 0.02);
      if (open) {
        // Lid thrown back against the sand, hinges torn. Nothing inside: the interior is a dark
        // well, which from a diver's eye level is the whole "already looted" signal.
        bag.box(0.92, 0.16, 0.58, 0, 0.30, -0.52, WOOD, 0, -1.15, 0);
        bag.box(0.78, 0.04, 0.46, 0, 0.44, 0, RUST_DK);
        bag.box(0.80, 0.30, 0.48, 0, 0.26, 0, DARK, 0, 0, 0);
      } else {
        // Domed lid, a gold hasp, and a coin caught under the rim - the glint that tells you
        // this one is still shut.
        bag.add(new THREE.CylinderGeometry(0.30, 0.30, 0.92, 10, 1, false, 0, Math.PI), new THREE.Matrix4().compose(V3(0, 0.44, 0), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI / 2, 'YXZ')), V3(1, 0.62, 1)), WOOD, 0.5);
        for (const sx of [-0.30, 0, 0.30]) bag.box(0.08, 0.10, 0.63, sx, 0.56, 0, RUST, 0, 0, 0);
        bag.box(0.14, 0.16, 0.06, 0, 0.42, 0.31, GOLD, 0, 0, 0);
        bag.add(new THREE.CylinderGeometry(0.055, 0.055, 0.014, 8), new THREE.Matrix4().compose(V3(0.22, 0.012, 0.36), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, h(1) * 3, 0)), V3(1, 1, 1)), GOLD, 0.1);
      }
      // Feet dug in, and a fan of coral on the shoulder.
      bag.box(0.10, 0.10, 0.10, -0.38, 0.03, 0.22, RUST_DK);
      bag.box(0.10, 0.10, 0.10, 0.38, 0.03, -0.22, RUST_DK);
      bag.add(new THREE.IcosahedronGeometry(0.17, 0), new THREE.Matrix4().compose(V3(-0.28 + h(2) * 0.5, 0.40, -0.26), new THREE.Quaternion(), V3(1, 0.5, 0.8)), ENC_PALE, 0.9);
      break;
    }
    case 'coins': {
      // A spill, not a container: the chest it was in is powder, and what is left is a low mound
      // of coin fused into the sand with a green brick of silver in the middle of it.
      // 0.86 m across. It started at 0.62 and, screenshotted from a diver's 2 m, read as a bump
      // in the sand with a dark smudge on it; a spill is the one container with no silhouette to
      // recognise, so it has to be wider and brighter than looked right in isolation.
      const r = 0.86, mh = open ? 0.07 : 0.13, my = -0.01;
      bag.add(new THREE.IcosahedronGeometry(1, 1), new THREE.Matrix4().compose(V3(0, my, 0), new THREE.Quaternion(), V3(r, mh, r * 0.78)), BALLAST, 0.5);
      if (!open) {
        bag.add(new THREE.BoxGeometry(0.40, 0.2, 0.28), new THREE.Matrix4().compose(V3(0.04, 0.10, -0.02), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.12, h(3) * 2, 0.1)), V3(1, 1, 1)), VERDIGRIS, 0.6);
      }
      // Loose coins on the mound: silver mostly, one or two gold. An emptied spill keeps two.
      const n = open ? 3 : 18;
      for (let i = 0; i < n; i++) {
        const a = h(10 + i) * 6.283, rr = (0.12 + 0.62 * h(30 + i)) * (open ? 1.3 : 1);
        const cx = Math.cos(a) * rr, cz = Math.sin(a) * rr * 0.78;
        // ON the mound's surface, not at a guessed height: the first version put them at a flat
        // 0.16 m and the ellipsoid swallowed every one of them (screenshotted - the spill was a
        // smooth dome with nothing on it).
        const cy = my + mh * Math.sqrt(Math.max(0, 1 - (rr / r) * (rr / r))) + 0.012;
        bag.add(new THREE.CylinderGeometry(0.075 + 0.02 * h(50 + i), 0.075, 0.014, 8), new THREE.Matrix4().compose(V3(cx, cy, cz), new THREE.Quaternion().setFromEuler(new THREE.Euler((h(70 + i) - 0.5) * 0.9, h(90 + i) * 3, (h(110 + i) - 0.5) * 0.9)), V3(1, 1, 1)), h(130 + i) < 0.3 ? GOLD : SILVER, 0.1);
      }
      break;
    }
    case 'crate': {
      // Deck cargo. Planked, iron-banded, and burst along one edge where it hit the bottom.
      const W = 0.78, H = 0.58, D = 0.62;
      for (const s of [-1, 1]) bag.box(0.05, H, D, s * W / 2, H / 2, 0, WOOD, 0, 0, 0);
      bag.box(W, H, 0.05, 0, H / 2, D / 2, WOOD);
      bag.box(W, H, 0.05, 0, H / 2, -D / 2, WOOD);
      for (const sy of [0.12, H - 0.12]) bag.box(W + 0.07, 0.05, D + 0.07, 0, sy, 0, RUST, 0, 0, 0);
      if (open) {
        // Lid planks prised off and dropped beside it; what is left is a dark empty box.
        bag.box(W * 0.9, 0.04, 0.16, 0.1, 0.03, D * 0.75, WOOD, 0.3, 0, 0.05);
        bag.box(W * 0.8, 0.04, 0.16, -0.14, 0.03, D * 0.95, WOOD, -0.2, 0, 0);
        bag.box(W - 0.1, 0.04, D - 0.1, 0, H - 0.08, 0, DARK);
      } else {
        for (let i = 0; i < 4; i++) bag.box(W / 4 - 0.02, 0.05, D, -W / 2 + W / 8 + i * W / 4, H, 0, WOOD, 0, 0, (h(4 + i) - 0.5) * 0.06);
        // Brass out of the split corner: the reason to bother with a wooden box.
        bag.add(new THREE.CylinderGeometry(0.045, 0.045, 0.22, 7), new THREE.Matrix4().compose(V3(W * 0.34, 0.07, D * 0.52), new THREE.Quaternion().setFromEuler(new THREE.Euler(1.3, 0.4, 0)), V3(1, 1, 1)), GOLD, 0.2);
      }
      bag.add(new THREE.IcosahedronGeometry(0.2, 0), new THREE.Matrix4().compose(V3(-W * 0.3, H * 0.75, -D * 0.4), new THREE.Quaternion(), V3(1, 0.55, 0.9)), ENC_ALGAE, 0.9);
      break;
    }
    case 'ammocan': {
      // A steel ammunition can, the paint gone, the whole thing an inch thick in verdigris.
      const W = 0.44, H = 0.30, D = 0.26;
      bag.box(W, H * (open ? 0.9 : 1), D, 0, H / 2, 0, VERDIGRIS, 0, 0, 0.03);
      bag.box(W * 0.92, 0.035, D * 0.9, 0, H * 0.55, 0, RUST_DK);
      if (open) {
        bag.box(W, 0.05, D, 0, H * 0.72, -D * 0.62, VERDIGRIS, 0, -1.25, 0);
        bag.box(W - 0.06, 0.03, D - 0.06, 0, H * 0.84, 0, DARK);
      } else {
        bag.box(W, 0.06, D, 0, H + 0.02, 0, VERDIGRIS, 0, 0, 0.03);
        bag.beam(V3(-W * 0.22, H + 0.12, 0), V3(W * 0.22, H + 0.12, 0), 0.022, SILVER, 5);
        bag.box(0.09, 0.07, 0.03, W * 0.44, H * 0.9, 0, RUST, 0, 0, 0);
      }
      bag.add(new THREE.IcosahedronGeometry(0.11, 0), new THREE.Matrix4().compose(V3(W * 0.2, H * 0.5, D * 0.45), new THREE.Quaternion(), V3(1, 0.7, 0.6)), ENC_SPONGE, 0.8);
      break;
    }
  }
  return bag.build();
}
