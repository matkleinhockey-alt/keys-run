/**
 * Small street animals: the squirrel, the skunk and the cat. Built in the spirit of the
 * seabirds (entities/life/seabirds.ts): a low-poly vertex-coloured body merged once per kind and
 * shared by every animal of it, a pose function that only writes rotations, and a placement
 * function that only writes a transform — no per-animal geometry, no per-animal material.
 *
 * ## Cost, which is the constraint
 * Each animal is exactly THREE meshes (body, head, tail) sharing one geometry per part and one
 * material for the lot, so five of them are fifteen draw calls and, crucially, zero extra shader
 * programs. The head and the tail are separate because they are what a squirrel or a skunk actually
 * DOES: the head goes down to sniff and bobs to nibble, and the tail is the whole character.
 * Legs are not meshes: at 20 cm tall a leg is a 4-pixel sliver at the distance anything is
 * visible, and a bounding body (bob + pitch) reads as running better than four sticks would.
 *
 * ## Scale, which is what makes them not rats
 * A squirrel is read by its tail, not its body. The body here is 24 cm and the tail plume arches to
 * 37 cm tall, bigger than the body, held over the back; sitting upright (the rump on the ground,
 * the chest up) is the other tell. A grey body with a tail the size of the body and a horizontal
 * posture is a rat, which is the first version's mistake and why `upright` is part of the pose.
 *
 * Everything is authored facing +z with its feet on y = 0 and its hips at the origin.
 */
import * as THREE from 'three';

interface Blob { rx: number; ry: number; rz: number; x: number; y: number; z: number; color: number }

const _c = new THREE.Color();
/** Street level is lit by a low sun behind the buildings: the first captures had a ginger cat reading brown and a gull reading grey. Vertex colours are lifted, like the town's own `lift`. */
const LIFT = 1.4;

/** Merge ellipsoids and boxes into one flat-shaded vertex-coloured geometry. */
function merge(blobs: readonly Blob[], boxes: ReadonlyArray<{ w: number; h: number; d: number; x: number; y: number; z: number; color: number }> = []): THREE.BufferGeometry {
  const pos: number[] = [], nor: number[] = [], col: number[] = [], idx: number[] = [];
  const push = (g: THREE.BufferGeometry, color: number): void => {
    const base = pos.length / 3, p = g.attributes.position, n = g.attributes.normal;
    _c.setHex(color).multiplyScalar(LIFT);
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); col.push(_c.r, _c.g, _c.b); }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
    g.dispose();
  };
  for (const b of blobs) {
    const g = new THREE.SphereGeometry(1, 8, 6);
    g.scale(b.rx, b.ry, b.rz); g.translate(b.x, b.y, b.z);
    push(g, b.color);
  }
  for (const b of boxes) {
    const g = new THREE.BoxGeometry(b.w, b.h, b.d);
    g.translate(b.x, b.y, b.z);
    push(g, b.color);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}

const blob = (rx: number, ry: number, rz: number, x: number, y: number, z: number, color: number): Blob => ({ rx, ry, rz, x, y, z, color });

/** One material for every critter: they are all vertex-coloured, so one shader program serves the lot. */
const CRITTER_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, flatShading: true });

export type CritterKind = 'squirrel' | 'skunk' | 'cat';

export interface Critter {
  kind: CritterKind;
  g: THREE.Group;
  /** The body pivots about the hips (origin): upright, bounding, rolling. */
  body: THREE.Group;
  head: THREE.Group;
  tail: THREE.Group;
}

interface Geos { body: THREE.BufferGeometry; head: THREE.BufferGeometry; tail: THREE.BufferGeometry; headAt: [number, number, number]; tailAt: [number, number, number] }
const GEOS: Partial<Record<CritterKind, Geos>> = {};

function squirrelGeos(): Geos {
  const FUR = 0x8f8b82, FUR_D = 0x77736a, BELLY = 0xcfa268, TIP = 0xc9c3b3;
  const body = merge([
    blob(0.052, 0.058, 0.115, 0, 0.085, 0.0, FUR),          // back
    blob(0.044, 0.04, 0.09, 0, 0.065, 0.015, BELLY),        // belly and chest, lighter
    blob(0.058, 0.06, 0.06, 0.0, 0.075, -0.07, FUR_D),      // haunches
    blob(0.016, 0.03, 0.03, -0.03, 0.02, -0.09, FUR_D),     // hind feet
    blob(0.016, 0.03, 0.03, 0.03, 0.02, -0.09, FUR_D),
    blob(0.012, 0.035, 0.012, -0.03, 0.03, 0.09, FUR_D),    // forelegs, held down in front
    blob(0.012, 0.035, 0.012, 0.03, 0.03, 0.09, FUR_D),
  ]);
  const head = merge([
    blob(0.042, 0.04, 0.05, 0, 0, 0.0, FUR),                // skull
    blob(0.021, 0.02, 0.03, 0, -0.012, 0.05, BELLY),        // muzzle
    blob(0.008, 0.007, 0.008, 0, -0.008, 0.078, 0x2a2220),  // nose
    blob(0.009, 0.009, 0.006, -0.03, 0.012, 0.03, 0x15110f), // eyes: big and black, the squirrel face
    blob(0.009, 0.009, 0.006, 0.03, 0.012, 0.03, 0x15110f),
    blob(0.011, 0.024, 0.008, -0.026, 0.045, -0.012, FUR_D), // ears with a hint of tuft
    blob(0.011, 0.024, 0.008, 0.026, 0.045, -0.012, FUR_D),
  ]);
  // the plume: seven overlapping ellipsoids arching up behind the body and curling forward over the back
  const arc: Array<[number, number, number, number]> = [[0, 0.0, -0.035, 0.035], [0, 0.04, -0.1, 0.05], [0, 0.1, -0.14, 0.062], [0, 0.17, -0.145, 0.068], [0, 0.23, -0.115, 0.066], [0, 0.275, -0.06, 0.056], [0, 0.29, 0.0, 0.045]];
  const tail = merge(arc.map(([x, y, z, r], i) => blob(r * 0.78, r * 1.18, r * 1.25, x, y, z, i > 4 ? TIP : i > 2 ? 0xa39e91 : FUR)));
  return { body, head, tail, headAt: [0, 0.135, 0.105], tailAt: [0, 0.08, -0.1] };
}

function skunkGeos(): Geos {
  const BLACK = 0x1a1819, WHITE = 0xf2f0e8, SNOUT = 0x2b2628;
  const body = merge([
    blob(0.085, 0.075, 0.165, 0, 0.115, 0.0, BLACK),
    blob(0.092, 0.082, 0.1, 0, 0.12, -0.1, BLACK),            // heavier hindquarters
    blob(0.022, 0.012, 0.19, -0.04, 0.188, -0.01, WHITE),     // the two stripes down the back
    blob(0.022, 0.012, 0.19, 0.04, 0.188, -0.01, WHITE),
  ], [
    { w: 0.04, h: 0.07, d: 0.055, x: -0.055, y: 0.035, z: 0.1, color: BLACK },
    { w: 0.04, h: 0.07, d: 0.055, x: 0.055, y: 0.035, z: 0.1, color: BLACK },
    { w: 0.045, h: 0.07, d: 0.06, x: -0.06, y: 0.035, z: -0.1, color: BLACK },
    { w: 0.045, h: 0.07, d: 0.06, x: 0.06, y: 0.035, z: -0.1, color: BLACK },
  ]);
  const head = merge([
    blob(0.05, 0.048, 0.06, 0, 0, 0.0, BLACK),
    blob(0.02, 0.02, 0.05, 0, -0.018, 0.075, SNOUT),          // narrow snout: this is what noses through bins
    blob(0.011, 0.01, 0.01, 0, -0.022, 0.125, 0x7a5a58),
    blob(0.012, 0.008, 0.06, 0, 0.044, 0.01, WHITE),          // the blaze up the forehead
    blob(0.017, 0.022, 0.01, -0.033, 0.045, -0.025, BLACK),
    blob(0.017, 0.022, 0.01, 0.033, 0.045, -0.025, BLACK),
    blob(0.007, 0.007, 0.006, -0.032, 0.012, 0.045, 0x0b0a0a),
    blob(0.007, 0.007, 0.006, 0.032, 0.012, 0.045, 0x0b0a0a),
  ]);
  // the great plume: black underneath, a white spine along the top
  const arc: Array<[number, number, number, number]> = [[0, 0.0, -0.06, 0.06], [0, 0.06, -0.13, 0.074], [0, 0.14, -0.18, 0.08], [0, 0.22, -0.19, 0.074], [0, 0.29, -0.16, 0.06], [0, 0.33, -0.1, 0.045]];
  const tail = merge([
    ...arc.map(([x, y, z, r]) => blob(r * 0.85, r * 1.2, r * 1.2, x, y, z, BLACK)),
    ...arc.slice(1).map(([x, y, z, r]) => blob(r * 0.42, r * 0.7, r * 0.9, x, y + r * 0.72, z - r * 0.35, WHITE)),
  ]);
  return { body, head, tail, headAt: [0, 0.125, 0.16], tailAt: [0, 0.13, -0.15] };
}

function catGeos(): Geos {
  const FUR = 0xd9892f, STRIPE = 0xa8601d, WHITE = 0xf1e6d2, PINK = 0xd9918f;
  const body = merge([
    blob(0.085, 0.105, 0.19, 0, 0.115, 0.0, FUR),            // a loaf
    blob(0.1, 0.1, 0.1, -0.015, 0.105, -0.1, FUR),
    blob(0.082, 0.1, 0.09, 0, 0.12, 0.1, FUR),
    blob(0.088, 0.016, 0.03, 0, 0.215, -0.04, STRIPE),       // tabby bars across the back
    blob(0.088, 0.016, 0.03, 0, 0.215, 0.03, STRIPE),
    blob(0.088, 0.016, 0.03, 0, 0.2, 0.1, STRIPE),
    blob(0.03, 0.04, 0.05, -0.04, 0.04, 0.17, WHITE),        // white socks
    blob(0.03, 0.04, 0.05, 0.04, 0.04, 0.17, WHITE),
  ]);
  const head = merge([
    blob(0.072, 0.066, 0.07, 0, 0, 0.0, FUR),
    blob(0.032, 0.024, 0.03, 0, -0.03, 0.06, WHITE),
    blob(0.009, 0.007, 0.007, 0, -0.012, 0.09, PINK),
    blob(0.012, 0.011, 0.01, -0.03, 0.015, 0.062, 0x8fc24a),   // green eyes
    blob(0.012, 0.011, 0.01, 0.03, 0.015, 0.062, 0x8fc24a),
    blob(0.026, 0.045, 0.014, -0.044, 0.07, -0.01, FUR),       // ears
    blob(0.026, 0.045, 0.014, 0.044, 0.07, -0.01, FUR),
    blob(0.014, 0.028, 0.008, -0.044, 0.064, 0.0, PINK),
    blob(0.014, 0.028, 0.008, 0.044, 0.064, 0.0, PINK),
    blob(0.06, 0.012, 0.018, 0, 0.056, 0.03, STRIPE),          // the M on the forehead, near enough
  ]);
  // a tail curled round the feet, the tip is what flicks
  const arc: Array<[number, number, number, number]> = [[0, 0, 0, 0.026], [0.05, 0, 0.0, 0.026], [0.09, 0, 0.05, 0.026], [0.09, 0, 0.11, 0.026], [0.06, 0, 0.17, 0.026], [0.02, 0, 0.2, 0.022]];
  const tail = merge(arc.map(([x, y, z, r], i) => blob(r, r, r * 1.35, x, y, z, i % 2 ? STRIPE : FUR)));
  return { body, head, tail, headAt: [0, 0.2, 0.15], tailAt: [0.07, 0.035, -0.17] };
}

function geosOf(kind: CritterKind): Geos {
  return GEOS[kind] ?? (GEOS[kind] = kind === 'squirrel' ? squirrelGeos() : kind === 'skunk' ? skunkGeos() : catGeos());
}

export function makeCritter(kind: CritterKind): Critter {
  const G = geosOf(kind);
  const g = new THREE.Group();
  const body = new THREE.Group();
  g.add(body);
  const bm = new THREE.Mesh(G.body, CRITTER_MAT); bm.castShadow = true; body.add(bm);
  const head = new THREE.Group(); head.position.set(...G.headAt); body.add(head);
  const hm = new THREE.Mesh(G.head, CRITTER_MAT); hm.castShadow = true; head.add(hm);
  const tail = new THREE.Group(); tail.position.set(...G.tailAt); body.add(tail);
  const tm = new THREE.Mesh(G.tail, CRITTER_MAT); tm.castShadow = true; tail.add(tm);
  return { kind, g, body, head, tail };
}

export interface CritterPoseIn {
  stance: string;
  /** Seconds, and a per-animal phase so two squirrels do not flick in unison. */
  t: number; ph: number;
  /** Gait phase, advancing with distance travelled. */
  step: number;
  speed: number;
  /** Heading of travel, for climbing: +1 up the trunk, -1 down, 0 on the flat. */
  climb: number;
  /** 0..1: how alarmed it is (the player is close). */
  alarm: number;
}

/** Pose a squirrel: upright and nibbling, flicking, bounding, or on a trunk. Writes rotations only. */
export function poseSquirrel(c: Critter, p: CritterPoseIn): void {
  const { body, head, tail } = c;
  const moving = p.speed > 0.3;
  const climbing = p.stance === 'climb' || p.stance === 'flick' && p.climb !== 0;
  const upright = p.stance === 'sit' || (p.stance === 'flick' && p.climb === 0) ? 0.95 : 0;
  if (climbing || p.stance === 'flick') {
    // on the trunk: head up (the caller pitches the whole group), a small hitching bob as it climbs
    body.rotation.set(0, 0, 0);
    body.position.y = moving ? Math.abs(Math.sin(p.step * 1.2)) * 0.012 : 0;
  } else if (moving) {
    // bounding: back arches and stretches once per stride, the whole body lifts
    const s = Math.sin(p.step);
    body.position.y = Math.max(0, s) * 0.055;
    body.rotation.x = -0.12 + s * 0.3;
  } else {
    body.position.y = 0;
    body.rotation.x = -upright;
  }
  // head: nibbling while sitting, scanning otherwise, nose into the wind when running
  if (p.stance === 'sit') { head.rotation.x = 0.25 + Math.sin(p.t * 17 + p.ph) * 0.14 * (Math.sin(p.t * 0.6 + p.ph) > 0 ? 1 : 0.15); head.rotation.y = Math.sin(p.t * 0.9 + p.ph) * 0.5; }
  else if (p.stance === 'flick') { head.rotation.x = -0.1; head.rotation.y = Math.sin(p.t * 1.3 + p.ph) * 0.7; }
  else { head.rotation.x = 0.0; head.rotation.y = Math.sin(p.t * 3 + p.ph) * 0.1 * (moving ? 0 : 1); }
  // tail: arched over the back at rest, streaming behind when running, and the FLICK
  if (p.stance === 'flick') {
    const burst = Math.sin(p.t * 0.9 + p.ph) > -0.2 ? 1 : 0.25;
    tail.rotation.set(-0.15 + Math.sin(p.t * 9 + p.ph) * 0.3 * burst, Math.sin(p.t * 4.5 + p.ph) * 0.18 * burst, 0);
  } else if (moving && !climbing) {
    tail.rotation.set(0.75 + Math.sin(p.step * 2) * 0.08, 0, 0);
  } else if (climbing) {
    tail.rotation.set(0.5, 0, 0);
  } else {
    tail.rotation.set(-0.1 + Math.sin(p.t * 1.2 + p.ph) * 0.05, Math.sin(p.t * 0.7 + p.ph) * 0.1, 0);
  }
  void p.alarm;
}

/** Pose a skunk: the waddle, the nose-down snuffle, and the stand-your-ground warning. */
export function poseSkunk(c: Critter, p: CritterPoseIn): void {
  const { body, head, tail } = c;
  const moving = p.speed > 0.08;
  if (moving) {
    // a lumbering roll, never in a hurry: the whole body sways side to side and the head rocks with it
    body.rotation.set(0, 0, Math.sin(p.step) * 0.07);
    body.position.y = Math.abs(Math.sin(p.step)) * 0.008;
    head.rotation.set(0.25 + Math.sin(p.step * 0.5) * 0.08, Math.sin(p.step) * 0.18, 0);
  } else {
    body.rotation.set(0, 0, 0);
    body.position.y = 0;
    if (p.stance === 'sniff') {
      // nose to the ground, working along it, with a snuffle
      head.rotation.set(0.62 + Math.sin(p.t * 7 + p.ph) * 0.07, Math.sin(p.t * 1.1 + p.ph) * 0.5, 0);
      body.rotation.x = 0.05;
    } else {
      head.rotation.set(0.1, Math.sin(p.t * 0.6 + p.ph) * 0.3, 0);
    }
  }
  const warn = Math.max(p.alarm, p.stance === 'freeze' ? 0.35 : 0);
  // tail: carried low and swaying; up as a plume when it is bothered. It does NOT run away.
  tail.rotation.set(0.35 - warn * 1.1 + Math.sin(p.t * 1.4 + p.ph) * 0.05, Math.sin(p.t * 0.8 + p.ph) * 0.1, 0);
  if (warn > 0.6) { head.rotation.x = 0.35 + Math.sin(p.t * 12) * 0.2; body.rotation.x = -0.04; } // the foot-stamp: front end bobs
}

/** Pose the cat: a loaf with a tail that has opinions and a head that follows things. */
export function poseCat(c: Critter, p: CritterPoseIn): void {
  const { body, head, tail } = c;
  body.rotation.set(0, 0, 0);
  body.position.y = Math.sin(p.t * 1.6 + p.ph) * 0.003; // breathing
  const watch = Math.sin(p.t * 0.21 + p.ph);
  head.rotation.set(0.05 + Math.sin(p.t * 0.33) * 0.06, watch * 0.9, 0);
  const flick = Math.sin(p.t * 0.5 + p.ph) > 0.55 ? Math.sin(p.t * 11) * 0.45 : 0;
  tail.rotation.set(0, flick + Math.sin(p.t * 0.7) * 0.08, 0);
}

/**
 * Place a critter: position, heading and (for a trunk) pitch. `pitch` is the nose-up angle of the whole
 * animal, so a squirrel on a palm is pitched +90 degrees and one running along the street is 0.
 */
export function placeCritter(c: Critter, x: number, y: number, z: number, yaw: number, pitch: number, scale: number): void {
  c.g.position.set(x, y, z);
  c.g.rotation.set(-pitch, yaw, 0, 'YXZ');
  c.g.scale.setScalar(scale);
}
