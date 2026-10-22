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
 *   - mascot    Gilly: a person in a head-to-knee fish suit, who walks the front of the room and waves.
 *               The only figure in here with a gait; see `mascot()` for what the suit replaces.
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
import { animateGait } from './people.js';
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

/**
 * Gilly: a person in a full-body fish costume, which is a different animal from the fish-print shirts
 * everyone else in here is wearing. It is still a `makeHuman` — walker legs, IK arms, the human's own
 * head swivel — but the suit covers everything above the knee, so the three merged body meshes the
 * constructor made (torso, head, hair) are HIDDEN and replaced by four of their own:
 *
 *   head shell   an oversized fish head worn over the shoulders: a googly eye bulging out of each
 *                side, a lipped open mouth with a dark throat behind it, three gill plates a side.
 *   pupils       the only reason the eyes are a second mesh — both pupils roll together, which is
 *                what makes a googly eye googly and costs one draw call for the pair.
 *   body shell   a tapering row of balls around the torso (the lobby fountain's marlin is built the
 *                same way), a dorsal ridge up the back, a forked tail behind, and a skirt over the
 *                hips so the thighs are not bare.
 *   two fins     stubby pectoral paddles, a fan of five rays each, parked on the hands every frame.
 *
 * Net cost against the figure it replaces: three meshes hidden, five added, so +2 draw calls for the
 * one mascot in the building. Everything a mascot suit does NOT cover — shins, ankles, white
 * sneakers — is the human's own, because the joke only lands if you can see there is a person in there.
 *
 * ## Why he walks
 * He is the one person in the casino who is not standing at a station, so he gets a real gait rather
 * than a pose: `animateGait` from people.ts, the same stride the street's crowd uses, over a 2.8 m
 * beat across the front of the room. The lane is `MASCOT_PACE` either side of where world/casino.ts
 * parks him (u 2.0..4.8, well clear of the 2 m entrance hall) and the gait phase is advanced by the
 * distance he actually covers, so the feet do not skate: the alternative, a constant phase rate, slid
 * visibly at the ends of the beat where he is barely moving.
 */
/** Albedo lift on the suit's batches. The casino has no sun and four PointLights for the whole town,
 * so its own geometry is built at `lift` 2.0 (casino-interior.ts); at 1.3 the suit came out navy
 * next to a room that is not. */
const SUIT_LIFT = 1.9;
const MASCOT_PACE = 1.4;
const MASCOT_BEAT = 14;

function mascot(npc: CasinoNpc, baseY: number): Built {
  const SUIT = 0x2a90cc, DEEP = 0x12527f, PALE = 0xe4f1fb, LIP = 0xff7f8f, THROAT = 0x4a0f18;
  const h = makeHuman({ walker: true, skin: 0xf0c2a0, hair: 0x1c1410, shirt: SUIT, shortSleeve: false, shorts: DEEP, shoes: 0xf4f4ea });
  h.group.scale.setScalar(1.12);
  // The suit, not the person: the merged torso (hips, chest, shoulders) and the head sit entirely
  // inside the shells below, so drawing them is two draw calls of geometry nobody can see.
  // `_dressParts.headMesh` is the only named handle on that merged head; `h.head.children[0]` would
  // work today but stops being the human's head the moment anything else is parented there first.
  (h.group.children[0] as THREE.Mesh).visible = false;
  h._dressParts.headMesh.visible = false;
  if (h.hair) h.hair.visible = false;

  // ---- the head shell, in the head's own frame (its origin is the base of the skull, hipY + 0.77).
  // Pushed 10 cm forward of that origin so the back of the skull clears the dorsal fin on the body.
  const hb = new GeoBatch(false, SUIT_LIFT);
  hb.ball(0, 0.04, 0.1, 0.33, SUIT, 0.94, 14);           // skull
  hb.ball(0, 0.12, -0.02, 0.3, DEEP, 0.86, 12);          // darker crown, so the head is not one flat colour
  hb.ball(0, -0.13, 0.18, 0.26, PALE, 0.6, 12);          // pale throat under the jaw
  hb.ball(0, -0.06, 0.28, 0.21, SUIT, 0.8, 12);          // the snout, carrying the mouth out past the skull
  // the mouth: a lip ring standing PROUD of the snout, with a dark disc recessed inside it. An
  // actual hole is not available — these are opaque overlapping balls — so the mouth has to be a
  // muzzle that sticks out far enough for the dark inside to clear every surface behind it.
  // 0.52, not 0.46: at 0.46 the dark disc sat INSIDE the snout ball (whose nose reaches 0.49) and
  // the mouth came out as a ring of lips round a patch of blue face
  hb.cyl(0, -0.11, 0.52, 0.15, 0.15, 0.08, THROAT, 12, { rx: Math.PI / 2 });
  // ten fat overlapping balls, not fourteen small ones: at r 0.06 the ring read as a string of beads
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    hb.ball(Math.cos(a) * 0.19, -0.07 + Math.sin(a) * 0.18, 0.52, 0.095, LIP, 1, 8);
  }
  for (const sx of [-1, 1]) hb.box(sx * 0.06, 0.05, 0.56, 0.06, 0.055, 0.03, 0xfbf6e8); // two daft front teeth
  hb.box(0, 0.34, -0.02, 0.05, 0.24, 0.3, DEEP, { rx: -0.3 });  // the crest, where a real fish's first dorsal starts
  // googly eyes: a white ball bulging out past the side of the head, on a dark rim that reads as a lid
  for (const sx of [-1, 1]) {
    hb.ball(sx * 0.21, 0.13, 0.17, 0.165, DEEP, 1, 10);
    hb.ball(sx * 0.235, 0.13, 0.18, 0.15, 0xfbfbf4, 1, 12);
    // gill plates: three to a side, raked back, in the pale colour so they read at 5 m instead of
    // disappearing into the blue of the head the way a darker set did
    for (let k = 0; k < 3; k++) hb.box(sx * (0.305 - k * 0.014), -0.02, 0.0 - k * 0.1, 0.03, 0.3, 0.075, k === 1 ? PALE : DEEP, { ry: sx * 0.22, rz: sx * 0.1 });
  }
  const suitMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62 });
  const headMesh = new THREE.Mesh(hb.build(), suitMat);
  h.head.add(headMesh);
  // the pupils, both on one mesh so the pair can roll together for one draw call
  const pb = new GeoBatch(false, SUIT_LIFT);
  for (const sx of [-1, 1]) {
    pb.ball(sx * 0.35, 0.13, 0.195, 0.065, 0x0d1118, 1, 9);
    pb.ball(sx * 0.36, 0.165, 0.23, 0.019, 0xffffff, 1, 6);
  }
  const pupils = new THREE.Mesh(pb.build(), suitMat);
  h.head.add(pupils);

  // ---- the body shell, in the figure's own frame (y measured from the floor). A tapering row of
  // balls, fine enough that the surface reads as one body: the first pass used six and came out a
  // lumpy pumpkin, and the three "stripe" discs laid over the back made it worse.
  const hipY = h.hipY, SH = hipY + 0.28;
  const sb = new GeoBatch(false, SUIT_LIFT);
  const shell: ReadonlyArray<readonly [number, number]> = [[0.36, 0.2], [0.27, 0.27], [0.17, 0.32], [0.06, 0.36], [-0.06, 0.38], [-0.18, 0.37], [-0.3, 0.32], [-0.41, 0.25], [-0.51, 0.17], [-0.59, 0.11]];
  for (const [z, r] of shell) sb.ball(0, SH, z, r, SUIT, 1.14, 12);
  for (const [z, r] of shell) if (r > 0.14) sb.ball(0, SH - r * 0.26, z, r * 0.9, PALE, 0.96, 10); // the belly
  // a skirt over the hips: without it the thighs come out of the shell bare and the figure reads as
  // a fish balloon on two naked legs rather than as a suit
  for (const [y, r] of [[hipY - 0.02, 0.31], [hipY - 0.16, 0.27], [hipY - 0.28, 0.22]] as const) sb.ball(0, y, 0.02, r, DEEP, 0.82, 10);
  // The dorsal: it has to start behind the head (the skull's back face is at z = -0.23) but ALSO
  // reach that far forward, because the shell is already curving away by z = -0.4 and the first
  // pass, two pieces from -0.38 back, read as a flag planted a hand's width off his back.
  sb.box(0, SH + 0.36, -0.28, 0.06, 0.24, 0.2, DEEP, { rx: 0.2 });
  sb.box(0, SH + 0.5, -0.43, 0.06, 0.3, 0.22, DEEP, { rx: 0.42 });
  sb.box(0, SH + 0.62, -0.57, 0.06, 0.22, 0.18, SUIT, { rx: 0.68 });
  // The tail: a peduncle long enough to actually touch the body, then four tapering pieces fanned
  // off the end of it. Two big lobes instead read as a pair of boards nailed to his back.
  sb.box(0, SH, -0.68, 0.13, 0.2, 0.26, DEEP);
  for (const s of [1, -1]) {
    sb.box(0, SH + s * 0.14, -0.86, 0.08, 0.26, 0.22, SUIT, { rx: -s * 0.35 });
    sb.box(0, SH + s * 0.3, -0.96, 0.07, 0.26, 0.18, DEEP, { rx: -s * 0.6 });
  }
  h.group.add(new THREE.Mesh(sb.build(), suitMat));

  // ---- the pectoral fins: a fan of five rays, parked on the hands in `update` rather than parented
  // to them, because `pose()` rewrites each hand's scale (0.95, 1.9, 0.6) every frame and a child
  // would inherit that squash
  const fb = new GeoBatch(false, SUIT_LIFT);
  // The fan is centred ON the hand rather than hung off the end of it, so it sheathes the forearm:
  // a bare arm cylinder sticking out of a fish suit was the loudest wrong note in the first capture.
  for (let k = -2; k <= 2; k++) fb.box(0, 0.0, 0, 0.05, 0.46 - Math.abs(k) * 0.07, 0.04, k % 2 ? PALE : SUIT, { rz: k * 0.17 });
  const finGeo = fb.build();
  const fins = [0, 1].map(() => { const m = new THREE.Mesh(finGeo, suitMat); h.group.add(m); return m; });

  // pacing state: `t` is a clock, not a delta, so the gait phase is integrated from the one frame gap
  // we can see. See the header for why the phase is driven by distance rather than by time.
  const W = (Math.PI * 2) / MASCOT_BEAT;
  let lastT = -1, gait = Math.PI;
  return {
    human: h,
    update(t) {
      const dt = lastT < 0 ? 0 : Math.min(0.1, Math.max(0, t - lastT));
      lastT = t;
      const u = npc.at.u + MASCOT_PACE * Math.sin(W * t);
      const speed = Math.abs(MASCOT_PACE * W * Math.cos(W * t));
      const amt = Math.max(0.4, Math.min(1.1, speed / 0.45));
      gait += (dt * speed * Math.PI * 2) / (1.2 * amt); // 1.2 m of ground per stride cycle at amount 1
      const bob = animateGait(h, gait, amt);
      // waving: the right fin up and swinging, the left out to the side. Slow: he has been at it since nine.
      const wv = Math.sin(t * 2.6);
      // both targets are OUTSIDE the shell (radius 0.38 at the waist, and the head is 0.33 across):
      // the first pass rested the left hand at x -0.34 and buried that whole arm inside his own belly
      // Both targets are OUTSIDE the shell (0.38 at the waist) and clear of the head (0.33 across,
      // centred 0.10 forward): the first pass rested the left hand inside his own belly and swung
      // the right one straight through his face, which from three metres read as a baton.
      h.pose(_a.set(-0.46, hipY + 0.18, 0.26), _b.set(0.54 + wv * 0.06, hipY + 0.72 + Math.abs(wv) * 0.1, 0.3));
      fins.forEach((f, i) => { f.position.copy(h.hands[i].position); f.quaternion.copy(h.hands[i].quaternion); });
      // ry 0 faces the door (the interior frame has z = -v), so saturating the facing on the
      // direction of travel means he turns to greet the room at each end of the beat and goes
      // side-on in the middle of it
      h.group.rotation.y = (Math.PI / 2) * Math.max(-1, Math.min(1, Math.cos(W * t) * 2.4));
      h.group.position.set(u, baseY + bob, Zf(npc.at.v));
      // the eyes roll, a beat behind the head swivel they are mounted on
      pupils.position.set(Math.sin(t * 1.9) * 0.022, Math.sin(t * 1.3 + 1) * 0.016 - 0.004, 0);
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
    : npc.look === 'pitboss' ? pitboss() : npc.look === 'mascot' ? mascot(npc, baseY) : punter(npc.variant + n);
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
