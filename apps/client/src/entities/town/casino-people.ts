/**
 * The people of the Gaff & Gill: fish-themed dealers, cashiers, a pit boss, a mascot and punters.
 *
 * Every one is a `makeHuman` figure (entities/life/human.ts, the same body as the captain, the deck
 * party and the street), dressed by changing its torso colours and by adding fish-shaped patches to
 * the torso's own vertex-coloured geometry. That last part matters for cost: the human's body is
 * ONE merged mesh, and the prints are appended INTO that mesh, so a fish-print shirt, a scale
 * waistcoat and a name tag add triangles and not a single draw call. (An earlier idea, a textured
 * decal mesh per figure, was rejected on exactly that ground: twelve people is twelve more draws
 * for a pattern nobody can see from 20 m.)
 *
 * ## The costumes (the register is this game's: a bikini deck party, a Luigi mode, a seagull who
 * calls you a loser. Funny, not seedy; everyone is fully dressed and a little over-committed.)
 *   - dealer    black vest with gold fish, red bow tie, a green eyeshade. Runs the Go Fish table.
 *   - cashier   teal fish-print shirt, yellow visor, name tag. Counts the same stack of ones all day.
 *   - pitboss   a waistcoat of overlapping silver TARPON SCALES, dark glasses, a gold chain. Sweeps
 *               the floor with his head and never, ever smiles.
 *   - mascot    Captain Marlin: a blue marlin suit with a bill, a sail and a very small tail. Waves.
 *   - punter    fish-print shirts in five patterns, caps, one in sunglasses at night.
 *
 * ## Animation (cheap on purpose)
 * Dealers shuffle, cashiers count, the mascot waves, punters tap the buttons and pull the lever: each
 * is a couple of `pose()` calls with sinusoidal hand targets. `animate(t)` is called by the casino
 * interior only for people within earshot of the camera (see casino-interior.ts), so a casino full of
 * people costs nothing from the street.
 */
import * as THREE from 'three';
import type { CasinoNpc } from '@keysrun/shared/world/casino';
import { makeHuman, type Human } from '../life/human.js';
import { GeoBatch } from './batch.js';
import { Zf } from './props.js';

// ---------------------------------------------------------------------------------------------
// Painting onto the torso
// ---------------------------------------------------------------------------------------------

/** The male torso's lathe profile in makeHuman: [radius, height above the hip joint + 0.03]. Copied from human.ts. */
const PROF: ReadonlyArray<readonly [number, number]> = [[0.155, 0], [0.165, 0.07], [0.148, 0.18], [0.135, 0.25], [0.15, 0.33], [0.168, 0.41], [0.172, 0.46], [0.155, 0.52], [0.09, 0.57], [0.05, 0.6]];
const Z_SQUASH = 0.66;

function radiusAt(y: number): number {
  if (y <= PROF[0][1]) return PROF[0][0];
  for (let i = 1; i < PROF.length; i++) {
    if (y <= PROF[i][1]) { const a = PROF[i - 1], b = PROF[i], t = (y - a[1]) / (b[1] - a[1]); return a[0] + (b[0] - a[0]) * t; }
  }
  return PROF[PROF.length - 1][0];
}

/** Collects triangles lying on the surface of a human's torso and appends them to its body mesh. */
class TorsoInk {
  private pos: number[] = []; private nor: number[] = []; private col: number[] = [];
  private readonly y0: number;
  private readonly c = new THREE.Color();
  constructor(private readonly human: Human) { this.y0 = human.hipY + 0.03; }

  /** A point on the torso at angle `a` (pi/2 = chest, -pi/2 = back) and height `y` above the hip, pushed `lift` out along the normal. */
  private at(a: number, y: number, lift: number): [number, number, number, number, number, number] {
    const r = radiusAt(Math.max(0, Math.min(0.6, y)));
    // outward normal of the squashed ellipse x^2/r^2 + z^2/(0.66r)^2 = 1
    const nx0 = Math.cos(a), nz0 = Math.sin(a) / Z_SQUASH, nl = Math.hypot(nx0, nz0), nx = nx0 / nl, nz = nz0 / nl;
    return [r * Math.cos(a) + nx * lift, this.y0 + y, r * Z_SQUASH * Math.sin(a) + nz * lift, nx, 0, nz];
  }
  private tri(p: [number, number, number, number, number, number][], color: number): void {
    this.c.setHex(color);
    // keep the winding facing outward whichever way round the caller listed the corners (the body material is single-sided)
    const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2], wx = p[2][0] - p[0][0], wy = p[2][1] - p[0][1], wz = p[2][2] - p[0][2];
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    if (cx * p[0][3] + cy * p[0][4] + cz * p[0][5] < 0) p = [p[0], p[2], p[1]];
    for (const q of p) { this.pos.push(q[0], q[1], q[2]); this.nor.push(q[3], q[4], q[5]); this.col.push(this.c.r, this.c.g, this.c.b); }
  }

  /** A quad patch spanning angles a0..a1 and heights y0..y1, curved around the body (two strips so it bends). */
  patch(a0: number, a1: number, y0: number, y1: number, color: number, lift = 0.004): void {
    const am = (a0 + a1) / 2;
    for (const [s, e] of [[a0, am], [am, a1]] as const) {
      const A = this.at(s, y0, lift), B = this.at(e, y0, lift), C = this.at(e, y1, lift), D = this.at(s, y1, lift);
      this.tri([A, B, C], color); this.tri([A, C, D], color);
    }
  }

  /** A small fish centred at (angle, height), `len` metres long, swimming toward +angle when `dir` is 1. */
  fish(a: number, y: number, len: number, dir: 1 | -1, body: number, fin: number, lift = 0.006): void {
    const r = radiusAt(y), h = len * 0.42;
    const da = (s: number): number => a + (dir * s) / r; // arc length -> angle
    const ring: Array<[number, number]> = [];
    for (let k = 0; k < 8; k++) { const t = (k / 8) * Math.PI * 2; ring.push([0.5 * len * Math.cos(t) * 0.8, 0.5 * h * Math.sin(t)]); }
    const centre = this.at(da(0), y, lift);
    for (let k = 0; k < 8; k++) {
      const p = ring[k], q = ring[(k + 1) % 8];
      this.tri([centre, this.at(da(p[0]), y + p[1], lift), this.at(da(q[0]), y + q[1], lift)], body);
    }
    // tail
    const t0 = this.at(da(-0.36 * len), y, lift);
    this.tri([t0, this.at(da(-0.62 * len), y + h * 0.62, lift), this.at(da(-0.62 * len), y - h * 0.62, lift)], fin);
    // dorsal fin
    this.tri([this.at(da(0.08 * len), y + h * 0.4, lift), this.at(da(-0.12 * len), y + h * 0.78, lift), this.at(da(-0.2 * len), y + h * 0.35, lift)], fin);
    // eye
    const e = this.at(da(0.26 * len), y + h * 0.1, lift + 0.002);
    this.tri([e, this.at(da(0.31 * len), y + h * 0.1, lift + 0.002), this.at(da(0.28 * len), y + h * 0.22, lift + 0.002)], 0x10202c);
  }

  /** A single overlapping scale: a diamond. */
  scale(a: number, y: number, w: number, h: number, color: number, lift = 0.006): void {
    const r = radiusAt(y), dw = w / r / 2;
    const c = this.at(a, y, lift);
    const l = this.at(a - dw, y, lift), rr = this.at(a + dw, y, lift), t = this.at(a, y + h / 2, lift), b = this.at(a, y - h / 2, lift);
    this.tri([c, l, t], color); this.tri([c, t, rr], color); this.tri([c, rr, b], color); this.tri([c, b, l], color);
  }

  commit(): void {
    const body = this.human.group.children[0] as THREE.Mesh;
    const g = body.geometry as THREE.BufferGeometry;
    const cat = (name: string, extra: number[], n: number): void => {
      const a = g.attributes[name] as THREE.BufferAttribute;
      const arr = new Float32Array(a.array.length + extra.length);
      arr.set(a.array as Float32Array); arr.set(extra, a.array.length);
      g.setAttribute(name, new THREE.BufferAttribute(arr, n));
    };
    cat('position', this.pos, 3); cat('normal', this.nor, 3); cat('color', this.col, 3);
    g.computeBoundingSphere();
  }
}

/** A Hawaiian-style fish print: rows of little fish, alternating direction, around the whole torso. */
function fishPrint(ink: TorsoInk, palette: ReadonlyArray<readonly [number, number]>, rows = [0.1, 0.22, 0.34, 0.46], cols = 9, scale = 1): void {
  rows.forEach((y, ri) => {
    for (let k = 0; k < cols; k++) {
      const a = (k / cols) * Math.PI * 2 + (ri % 2) * (Math.PI / cols);
      const [b, f] = palette[(k + ri * 2) % palette.length];
      ink.fish(a, y, (0.085 + 0.012 * ((k * 7 + ri) % 3)) * scale, (k + ri) % 2 ? 1 : -1, b, f);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The costumes
// ---------------------------------------------------------------------------------------------

const SKIN = [0xd9a27f, 0xe9b48f, 0xc98d68, 0xb87a55, 0xf0c2a0, 0x9a6644];
const HAIR = [0x3b2a1e, 0x1c1410, 0x7a3a1c, 0xd8b46a, 0x5a3825, 0xb8b8b0];

const SHIRTS: ReadonlyArray<{ base: number; pal: ReadonlyArray<readonly [number, number]> }> = [
  { base: 0xf26b5b, pal: [[0xffe27a, 0xffffff], [0xffffff, 0xffe27a], [0x35e0ff, 0xffffff]] },        // coral, with yellow and white fish
  { base: 0x1f7fa8, pal: [[0xffffff, 0xaee8ff], [0xffd36e, 0xffffff], [0xff7a8a, 0xffffff]] },        // ocean blue
  { base: 0x2f8f5a, pal: [[0xffb347, 0xffe0a0], [0xffffff, 0xffb347], [0xf2f2c8, 0xffb347]] },        // reef green, orange snapper
  { base: 0xf2c14e, pal: [[0x1f7fa8, 0x35e0ff], [0xe8573d, 0xffffff], [0x1b3a66, 0x35e0ff]] },        // sunny, with blue marlin
  { base: 0xe86aa8, pal: [[0xffffff, 0xffd23f], [0x35e0ff, 0xffffff], [0xffd23f, 0xffffff]] },        // flamingo pink
];

interface Built { human: Human; update(t: number): void }

export interface CasinoPerson {
  npc: CasinoNpc;
  human: Human;
  baseY: number;
  update(t: number): void;
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3();

function dealer(i: number): Built {
  const h = makeHuman({ walker: true, skin: SKIN[(i + 2) % SKIN.length], hair: HAIR[(i * 2) % HAIR.length], shirt: 0xf3efe5, shortSleeve: false, shorts: 0x111114, shortsLong: true, shoes: 0x111114, cap: 0x1f6b44, glasses: i === 1, longHair: i === 1, hairStyle: 'bun' });
  const ink = new TorsoInk(h);
  // the vest: black front panels, gold fish, a red bow tie
  ink.patch(Math.PI / 2 - 1.3, Math.PI / 2 - 0.05, 0.1, 0.5, 0x15161a); ink.patch(Math.PI / 2 + 0.05, Math.PI / 2 + 1.3, 0.1, 0.5, 0x15161a);
  ink.patch(-Math.PI / 2 - 1.3, -Math.PI / 2 + 1.3, 0.1, 0.5, 0x15161a);
  for (const [a, y, d] of [[Math.PI / 2 - 0.7, 0.36, 1], [Math.PI / 2 + 0.7, 0.36, -1], [Math.PI / 2 - 0.7, 0.2, -1], [Math.PI / 2 + 0.7, 0.2, 1]] as const) ink.fish(a, y, 0.075, d, 0xe0b34a, 0xffd96a);
  ink.patch(Math.PI / 2 - 0.2, Math.PI / 2 + 0.2, 0.5, 0.55, 0xc4262e);
  ink.commit();
  return {
    human: h,
    update(t) {
      // shuffling: both hands working a deck over the table
      const k = t * 7 + i;
      h.pose(_a.set(-0.12 + Math.sin(k) * 0.05, h.hipY + 0.36, 0.38 + Math.cos(k * 1.3) * 0.03), _b.set(0.12 + Math.sin(k + 2) * 0.05, h.hipY + 0.36, 0.38 + Math.cos(k * 1.1 + 1) * 0.03));
    },
  };
}

function cashier(i: number): Built {
  const h = makeHuman({ walker: true, skin: SKIN[(i * 3 + 1) % SKIN.length], hair: HAIR[(i * 2 + 1) % HAIR.length], shirt: 0x1f9aa8, shortSleeve: true, shorts: 0x23262a, cap: 0xffd23f, glasses: i === 0, longHair: i === 1, hairStyle: 'pony' });
  const ink = new TorsoInk(h);
  fishPrint(ink, [[0xffffff, 0xaee8ff], [0xffe27a, 0xffffff], [0xffffff, 0xffe27a]], [0.08, 0.2, 0.32, 0.44]);
  ink.patch(Math.PI / 2 - 0.62, Math.PI / 2 - 0.3, 0.34, 0.42, 0xf8f8f0, 0.008); // the name tag
  ink.commit();
  return {
    human: h,
    update(t) {
      // counting a stack of ones: one hand flicking notes, the other holding the pile
      const k = t * 6 + i * 2;
      h.pose(_a.set(-0.2, h.hipY + 0.32, 0.32), _b.set(0.14 + Math.sin(k) * 0.07, h.hipY + 0.34 + Math.abs(Math.sin(k * 0.5)) * 0.06, 0.34));
    },
  };
}

function pitboss(): Built {
  const h = makeHuman({ walker: true, skin: 0xb87a55, hair: 0x15110e, shirt: 0x15202a, shortSleeve: false, shorts: 0x15161a, shortsLong: true, shoes: 0x0e0e10, glasses: true });
  h.group.scale.setScalar(1.08);
  const ink = new TorsoInk(h);
  // The waistcoat of tarpon scales: the whole front, and the back, in overlapping silver diamonds.
  const SIL = [0xe2eaf0, 0xb7c5d0, 0xcdd9e1, 0x9fb0bd];
  for (const [a0, a1] of [[Math.PI / 2 - 1.15, Math.PI / 2 - 0.04], [Math.PI / 2 + 0.04, Math.PI / 2 + 1.15], [-Math.PI / 2 - 1.2, -Math.PI / 2 + 1.2]] as const) ink.patch(a0, a1, 0.1, 0.5, 0x2b3a46);
  for (let row = 0; row < 8; row++) {
    const y = 0.14 + row * 0.048, off = row % 2 ? 0.1 : 0;
    for (let k = 0; k < 6; k++) {
      for (const sgn of [-1, 1]) ink.scale(Math.PI / 2 + sgn * (0.1 + k * 0.2 + off), y, 0.062, 0.07, SIL[(k + row) % SIL.length]);
      ink.scale(-Math.PI / 2 + (k - 2.5) * 0.36 + off, y, 0.06, 0.07, SIL[(k + row) % SIL.length]);
    }
  }
  ink.patch(Math.PI / 2 - 0.12, Math.PI / 2 + 0.12, 0.5, 0.54, 0x111114); // a plain black tie: he does not do fun
  ink.commit();
  // the gold chain, with a fish on it
  const jewel = new GeoBatch(false, 1.4);
  for (let k = 0; k < 14; k++) { const a = Math.PI * (0.12 + 0.76 * (k / 13)); jewel.ball(Math.cos(a) * 0.1, 0.42 + h.hipY - 0.02 - Math.sin(a) * 0.0, Math.sin(a) * 0.075 * 1.0, 0.012, 0xe0b34a, 1, 5); }
  jewel.box(0, h.hipY + 0.33, 0.12, 0.05, 0.03, 0.01, 0xe0b34a);
  const jm = new THREE.Mesh(jewel.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.7 }));
  h.group.add(jm);
  return {
    human: h,
    update(t) {
      // sweeping the floor with his whole upper body, hands clasped low in front of him
      h.group.userData.sweep = Math.sin(t * 0.45) * 0.55;
      h.pose(_a.set(-0.06, h.hipY + 0.26, 0.2), _b.set(0.06, h.hipY + 0.26, 0.2));
    },
  };
}

function mascot(): Built {
  const h = makeHuman({ walker: true, skin: 0xf0c2a0, hair: 0x1c1410, shirt: 0x1f6fb0, shortSleeve: true, shorts: 0x134a7a, shoes: 0xffd23f });
  h.group.scale.setScalar(1.14);
  const ink = new TorsoInk(h);
  ink.patch(Math.PI / 2 - 0.85, Math.PI / 2 + 0.85, 0.06, 0.48, 0xdcecf8); // pale belly
  for (let k = 0; k < 4; k++) ink.patch(-Math.PI / 2 - 0.9 + k * 0.45, -Math.PI / 2 - 0.9 + k * 0.45 + 0.22, 0.1, 0.5, 0x7fd0ff); // back stripes
  ink.commit();
  // the head: a marlin's, over a human's, with a bill you could open a letter with
  const hb = new GeoBatch(false, 1.3);
  hb.ball(0, 0.06, 0.03, 0.2, 0x1f6fb0, 1.05, 14);
  hb.ball(0, 0.0, 0.1, 0.16, 0xdcecf8, 0.8, 12); // pale chin
  hb.cyl(0, 0.07, 0.46, 0.005, 0.04, 0.52, 0x14335a, 8, { rx: Math.PI / 2 });
  for (const sx of [-1, 1]) {
    hb.ball(sx * 0.115, 0.1, 0.12, 0.052, 0xffffff, 1, 10);
    hb.ball(sx * 0.12, 0.1, 0.16, 0.026, 0x10202c, 1, 8);
    hb.box(sx * 0.19, 0.0, 0.0, 0.01, 0.08, 0.1, 0x134a7a, { rz: sx * 0.25 }); // gill
  }
  hb.box(0, 0.3, -0.04, 0.02, 0.2, 0.26, 0x1a3f86, { rx: -0.35 }); // the sail
  hb.box(0, 0.23, 0.07, 0.02, 0.08, 0.08, 0x1a3f86);
  const hm = new THREE.Mesh(hb.build(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }));
  h.head.add(hm);
  // a tail fin on the back, because a suit with no tail is a costume and one with a tail is a mascot
  const tb = new GeoBatch(false, 1.3);
  tb.box(0, h.hipY + 0.05, -0.24, 0.03, 0.26, 0.12, 0x14335a, { rx: 0.3 });
  tb.box(0, h.hipY + 0.2, -0.28, 0.03, 0.22, 0.1, 0x1f6fb0, { rx: -0.35 });
  tb.box(0, h.hipY - 0.1, -0.24, 0.03, 0.22, 0.1, 0x1f6fb0, { rx: 0.7 });
  h.group.add(new THREE.Mesh(tb.build(), hm.material));
  return {
    human: h,
    update(t) {
      // waving: the right hand up and swinging, the left on his hip. Slow: he has been doing it since nine.
      const w = Math.sin(t * 3.2);
      h.pose(_a.set(-0.25, h.hipY + 0.2, 0.0), _b.set(0.3 + w * 0.08, h.hipY + 0.95 + Math.abs(w) * 0.04, 0.12));
    },
  };
}

function punter(i: number): Built {
  const shirt = SHIRTS[i % SHIRTS.length];
  const female = i === 1 || i === 3;
  const h = makeHuman({
    walker: true, skin: SKIN[(i * 5 + 1) % SKIN.length], hair: HAIR[(i * 3 + 2) % HAIR.length], shirt: shirt.base, shortSleeve: true,
    shorts: female ? 0xd8c7a0 : 0x6b5a3a, shoes: 0xe9e4d8, cap: i === 0 || i === 4 ? 0x23466e : undefined, glasses: i === 2 || i === 4,
    longHair: female, hairStyle: female ? (i === 1 ? 'wavy' : 'pony') : undefined,
  });
  const ink = new TorsoInk(h);
  fishPrint(ink, shirt.pal, [0.09, 0.21, 0.33, 0.45], 9, 1.1);
  ink.commit();
  return {
    human: h,
    update(t) {
      // working the machine: one hand tapping the buttons, the other on the lever when the reels go round
      const k = t * 2.2 + i * 1.7;
      const lever = Math.max(0, Math.sin(k * 0.5)) ** 3;
      h.pose(_a.set(-0.2, h.hipY + 0.5, 0.36 + Math.sin(k * 5) * 0.015), _b.set(0.26, h.hipY + 0.62 - lever * 0.28, 0.3));
    },
  };
}

export function makeCasinoPerson(npc: CasinoNpc, baseY: number): CasinoPerson {
  const n = Number(/(\d+)$/.exec(npc.id)?.[1] ?? 0);
  const b = npc.look === 'dealer' ? dealer(npc.variant) : npc.look === 'cashier' ? cashier(npc.variant)
    : npc.look === 'pitboss' ? pitboss() : npc.look === 'mascot' ? mascot() : punter(npc.variant + n);
  const g = b.human.group;
  g.position.set(npc.at.u, baseY, Zf(npc.at.v));
  const ry = Math.atan2(Math.cos(npc.at.yaw), -Math.sin(npc.at.yaw));
  g.rotation.y = ry;
  const bare = npc.look === 'pitboss';
  return {
    npc, human: b.human, baseY,
    update(t) {
      b.update(t);
      if (bare) g.rotation.y = ry + (g.userData.sweep as number ?? 0);
      b.human.update(t, 0);
    },
  };
}
