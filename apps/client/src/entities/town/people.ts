/**
 * The people of Boot Key Harbor City: joggers, shoppers, couples photographing the water, a man
 * loading a cooler into his truck, somebody on a bench, a bouncer, a bartender.
 *
 * Reuses `makeHuman` (entities/life/human.ts), the same figure as the boat's captain and deck
 * party, with `walker: true` so it has real jointed IK legs. That function already knows how to
 * pose limbs from target points (`pose`, `poseLegs`); this file adds the stances (walk, jog, sit,
 * phone, talk, knock, stretch, load...) that drive those targets, and the cost control.
 *
 * ## Where they are: world/town-life.ts
 * Every moving figure is a SCRIPT there: a pure function of the clock (`sample(script, t)`), so
 * the shared test proves they never leave the sidewalks or overlap, and so this file integrates
 * nothing: no per-frame position state, nothing to advance while you are elsewhere, nothing that
 * can drift. Standers (bouncer, smoker, chatters, a fisherman) are the same thing with a script
 * that never moves.
 *
 * ## Tiers, by distance from the camera (the cost is the constraint)
 * A `makeHuman` is ~19 draw calls (body, head, hair, 2 x (upper arm, forearm, elbow, hand), 2 x (thigh,
 * knee, calf, foot)), and the first perf pass measured the old 13-strong crowd at ~280 draw calls in
 * the street. Doubling the crowd at that price was not an option, so there are three tiers:
 *   - REAL_RANGE (48 m) and the REAL_MAX nearest: a full `makeHuman` with IK stances and props. Built
 *     lazily, ONE per frame, the first time someone is that close: construction is the most
 *     expensive thing in the town and must not land as a hitch.
 *   - out to PROXY_RANGE (150 m): ONE instanced silhouette (legs, torso, head = 3 draw calls for the
 *     WHOLE crowd, coloured per instance from the person's own clothes). At 50 m a person is 25
 *     pixels tall; what reads is a coloured shape that moves at the right speed, and it does.
 *   - beyond: nothing, not even the pose.
 * Measured before and after: see the report in the commit message; the proxy is what keeps a street
 * with 3x the people at the same draw-call budget.
 */
import * as THREE from 'three';
import { NPCS, PAD_Y, type Npc } from '@keysrun/shared/world/town';
import { PEOPLE, sample, newPose, type LifePerson, type LifePose, type PropKind, type Script, type CrowdLook } from '@keysrun/shared/world/town-life';
import { makeHuman, type Human, type HumanOptions } from '../life/human.js';
import { Zf } from './props.js';

/** The whole crowd is hidden beyond this, metres from the camera to the nearest edge of the street. */
export const PEOPLE_RANGE = 170;
/** Out to here a figure is drawn at all (as a proxy silhouette beyond REAL_RANGE). */
export const PROXY_RANGE = 150;
/** Within this a figure is a full jointed human (if the budget below allows). */
export const REAL_RANGE = 48;
/** At most this many full humans at once: 19 draw calls each is the budget. */
export const REAL_MAX = 10;
/** Legs and arms are solved by IK only inside this. */
export const GAIT_RANGE = 36;
/** Head glances and blinks only inside this. */
const FACE_RANGE = 24;

const SHIRTS = [0xf26b5b, 0x3fb6c9, 0xf2c14e, 0x7bc96f, 0xe86aa8, 0xffffff, 0x5a7bd6, 0xff9f43];
const HAIR = [0x3b2a1e, 0x1c1410, 0x7a3a1c, 0xd8b46a, 0x5a3825, 0x2e1c12];
const SKIN = [0xd9a27f, 0xe9b48f, 0xc98d68, 0xb87a55, 0xf0c2a0, 0x9a6644];

type Look = CrowdLook | Npc['look'];

export function humanOptionsFor(look: Look, i: number): HumanOptions {
  const base: HumanOptions = { walker: true, skin: SKIN[i % SKIN.length], hair: HAIR[(i * 3) % HAIR.length], shirt: SHIRTS[i % SHIRTS.length], shorts: 0xcdbf9a, shoes: 0xe9e4d8 };
  switch (look) {
    case 'tourist': return { ...base, shortSleeve: true, cap: i % 2 ? 0xffffff : undefined, glasses: i % 3 === 0, shorts: 0xe9e1c8 };
    case 'angler': return { ...base, shirt: 0x6b7f8a, shortSleeve: true, cap: 0x23466e, shorts: 0x4d5a4a, shoes: 0x5a4a38 };
    case 'local': return { ...base, shirt: i % 2 ? 0x2f2f33 : 0xb8423a, shortSleeve: true, cap: 0x2b2118, shorts: 0x3d4a5a, shoes: 0xc9c2b2 };
    case 'woman': return { ...base, longHair: true, hairStyle: (['long', 'wavy', 'pony', 'bun'] as const)[i % 4], shirt: SHIRTS[(i + 2) % SHIRTS.length], shortSleeve: true, shorts: 0x3d5a8a };
    case 'bouncer': return { ...base, shirt: 0x111114, shorts: 0x111114, shortsLong: true, glasses: true, shoes: 0x111114, skin: 0xb87a55, shortSleeve: true };
    case 'bartender': return { ...base, shirt: 0xf3efe5, shortSleeve: true, shorts: 0x2b2118, hair: 0x7a3a1c, longHair: true, hairStyle: 'bun' };
    case 'cook': return { ...base, shirt: 0xffffff, cap: 0xffffff, shorts: 0x23262a, shortSleeve: true };
    case 'patron': return { ...base, shortSleeve: true, cap: 0x5a7bd6, shorts: 0x6b5a3a };
    // a runner is the only person on the street dressed for it: neon top, short shorts, a visor or a pony tail
    case 'jogger': return { ...base, longHair: true, hairStyle: 'pony', shirt: 0xff4f9a, shortSleeve: true, shorts: 0x23262a, shoes: 0xf2f23a, skin: SKIN[(i + 1) % SKIN.length] };
    case 'jogger-m': return { ...base, shirt: 0x2fd6c4, shortSleeve: true, shorts: 0x1d2a44, shoes: 0xffffff, cap: 0xffffff };
    case 'kid': return { ...base, shirt: [0xffd23f, 0x3fb6c9, 0xff7a59][i % 3], shortSleeve: true, shorts: 0x3d5a8a, shoes: 0xff7a59, cap: i % 2 ? 0xe4572e : undefined };
    case 'worker': return { ...base, shirt: 0x7d8a93, shortSleeve: true, shorts: 0x4a4f55, shoes: 0x5a4a38, cap: 0xd9b24a, glasses: true };
    case 'granny': return { ...base, longHair: true, hairStyle: 'bun', hair: 0xe6e2da, shirt: 0xc8b6e0, shortSleeve: true, shorts: 0xdad3c2, glasses: true, shoes: 0xf2efe6 };
  }
}

// ---------------------------------------------------------------------------------------------
// Gait and stances
// ---------------------------------------------------------------------------------------------

const V = (x = 0, y = 0, z = 0): THREE.Vector3 => new THREE.Vector3(x, y, z);
const _fl = V(), _fr = V(), _hl = V(), _hr = V();

/**
 * One stride cycle: legs swing on opposite phases with a lifted heel at the front of the swing,
 * arms counter-swing, the body bobs twice per cycle. Targets are in the human's own frame, which
 * is exactly what `poseLegs`/`pose` expect (feet near y=0.085, hips at `hipY`). Returns the body bob.
 */
export function animateGait(h: Human, phase: number, amount: number): number {
  const sw = Math.sin(phase), sw2 = Math.sin(phase + Math.PI);
  const stride = 0.3 * amount;
  const lift = (s: number): number => Math.max(0, Math.cos(s)) * 0.11 * amount;
  _fl.set(-0.105, 0.085 + lift(phase), sw * stride);
  _fr.set(0.105, 0.085 + lift(phase + Math.PI), sw2 * stride);
  h.poseLegs(_fl, _fr);
  _hl.set(-0.24, h.hipY + 0.0, 0.05 + sw2 * 0.22 * amount);
  _hr.set(0.24, h.hipY + 0.0, 0.05 + sw * 0.22 * amount);
  h.pose(_hl, _hr);
  return Math.abs(Math.sin(phase)) * 0.035 * amount;
}

/** A runner's arms: bent at the elbow, driving. Same legs as a walk, at a longer stride. */
function animateJog(h: Human, phase: number): number {
  const sw = Math.sin(phase), sw2 = Math.sin(phase + Math.PI);
  _fl.set(-0.1, 0.085 + Math.max(0, Math.cos(phase)) * 0.2, sw * 0.4);
  _fr.set(0.1, 0.085 + Math.max(0, Math.cos(phase + Math.PI)) * 0.2, sw2 * 0.4);
  h.poseLegs(_fl, _fr);
  _hl.set(-0.2, h.hipY + 0.2, 0.18 + sw2 * 0.2);
  _hr.set(0.2, h.hipY + 0.2, 0.18 + sw * 0.2);
  h.pose(_hl, _hr);
  return Math.abs(Math.sin(phase)) * 0.06;
}

/** Hands held low in front, for something carried in both. */
function carryHands(h: Human, lift = 0.2, fwd = 0.32): void {
  _hl.set(-0.17, h.hipY + lift, fwd); _hr.set(0.17, h.hipY + lift, fwd);
  h.pose(_hl, _hr);
}

const FEET_L = V(-0.105, 0.085, 0), FEET_R = V(0.105, 0.085, 0);

/** Where the seat is: hips ~9 cm above a 48 cm bench, so the body is this much lower than standing. */
const SIT_DROP = 0.575 - 0.93;

export interface PersonRig {
  fig: Figure;
  human: Human;
  props: THREE.Object3D[];
}

/** Set limbs for `stance`. `phase` is the gait phase; returns the vertical offset of the group. */
function applyStance(h: Human, fig: Figure, p: LifePose, t: number, moving: boolean): number {
  const hy = h.hipY, st = p.stance, ph = fig.ph;
  if (moving && (st === 'walk' || st === 'carry' || st === 'phone' || st === 'jog')) {
    if (st === 'jog') return animateJog(h, fig.gait);
    const amt = Math.max(0.35, Math.min(1.3, p.speed / 1.25));
    const bob = animateGait(h, fig.gait, amt);
    if (st === 'carry') carryHands(h, 0.2, 0.3);
    else if (st === 'phone') { _hr.set(0.12, hy + 0.5, 0.26); _hl.set(-0.24, hy, 0.05); h.pose(_hl, _hr); }
    return bob;
  }
  switch (st) {
    case 'sit': case 'sitphone': {
      _fl.set(-0.12, 0.355 + 0.085, 0.36); _fr.set(0.12, 0.355 + 0.085, 0.36);
      h.poseLegs(_fl, _fr);
      if (st === 'sitphone') { _hr.set(0.1, hy + 0.5, 0.28); _hl.set(-0.15, hy + 0.1, 0.3); } else { _hl.set(-0.15, hy + 0.12, 0.3); _hr.set(0.15, hy + 0.12, 0.3); }
      h.pose(_hl, _hr);
      h.head.rotation.x = st === 'sitphone' ? 0.4 : 0.05;
      return SIT_DROP;
    }
    case 'talk': {
      h.poseLegs(FEET_L, FEET_R);
      const g = Math.sin(t * 2.6 + ph) * 0.5 + 0.5;
      _hr.set(0.26, hy + 0.2 + g * 0.22, 0.26 + g * 0.1); _hl.set(-0.24, hy, 0.05 + Math.sin(t * 1.3 + ph) * 0.05);
      h.pose(_hl, _hr);
      return 0;
    }
    case 'phone': {
      h.poseLegs(FEET_L, FEET_R);
      _hr.set(0.11, hy + 0.5, 0.27); _hl.set(-0.2, hy + 0.04, 0.12);
      h.pose(_hl, _hr);
      h.head.rotation.x = 0.4;
      return 0;
    }
    case 'knock': {
      h.poseLegs(FEET_L, FEET_R);
      _hr.set(0.16, hy + 0.5, 0.42 + Math.max(0, Math.sin(t * 9 + ph)) * 0.08); _hl.set(-0.24, hy, 0.05);
      h.pose(_hl, _hr);
      return 0;
    }
    case 'stretch': {
      // arms overhead and a lean: what a runner does at the end of a promenade
      h.poseLegs(V(-0.2, 0.085, 0), V(0.2, 0.085, 0));
      const s = Math.sin(t * 0.9 + ph) * 0.15;
      _hl.set(-0.14 + s, hy + 1.0, 0.03); _hr.set(0.14 + s, hy + 1.0, 0.03);
      h.pose(_hl, _hr);
      return Math.sin(t * 0.9 + ph) * 0.01;
    }
    case 'load': {
      h.poseLegs(V(-0.14, 0.085, 0.05), V(0.14, 0.085, -0.1));
      const k = 0.5 - 0.5 * Math.cos(Math.min(1, p.bt / 2.2) * Math.PI);
      const up = fig.look === 'worker' && p.carrying ? 1 - k : k;
      _hl.set(-0.2, hy + 0.1 + up * 0.28, 0.34 + up * 0.1); _hr.set(0.2, hy + 0.1 + up * 0.28, 0.34 + up * 0.1);
      h.pose(_hl, _hr);
      return 0;
    }
    case 'carry': { h.poseLegs(FEET_L, FEET_R); carryHands(h, 0.22, 0.32); return 0; }
    case 'look': {
      h.poseLegs(FEET_L, FEET_R);
      _hl.set(-0.24, hy, 0.05); _hr.set(0.24, hy, 0.05);
      h.pose(_hl, _hr);
      h.head.rotation.x = -0.04;
      return 0;
    }
    default: {
      h.poseLegs(FEET_L, FEET_R);
      const sway = Math.sin(t * 0.8 + ph) * 0.02;
      _hl.set(-0.24, hy, 0.05 + sway); _hr.set(0.24, hy, 0.05 - sway);
      h.pose(_hl, _hr);
      return 0;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Props: shared geometry and materials, one tiny Object3D per carried thing
// ---------------------------------------------------------------------------------------------

const PM = (c: number, rough = 0.7): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color: c, roughness: rough });
const PROP_MATS = { white: PM(0xf2f2ee), blue: PM(0x2b6cb0), brown: PM(0x9a7448), dark: PM(0x23262a, 0.5), red: PM(0xb3202a), teal: PM(0x2bb3a8), cone: PM(0xd9a85c), pink: PM(0xf7a7c6), paper: PM(0xe9e3d2), green: PM(0x2f6b3a, 0.35), basket: PM(0x6fb7d9) };
const PROP_GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 8),
  cone: new THREE.ConeGeometry(1, 1, 8),
  ball: new THREE.SphereGeometry(1, 8, 6),
};

function part(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(sx, sy, sz); m.position.set(x, y, z); m.castShadow = true;
  parent.add(m);
  return m;
}

/** A carried thing, authored with its grip at the origin. */
export function makeProp(kind: PropKind): THREE.Group {
  const g = new THREE.Group();
  switch (kind) {
    case 'rod': {
      part(g, PROP_GEO.cyl, PROP_MATS.dark, 0.012, 2.1, 0.012, 0, 0.7, 0);
      part(g, PROP_GEO.cyl, PROP_MATS.dark, 0.035, 0.05, 0.035, 0, 0.0, 0.03).rotation.z = Math.PI / 2;
      g.rotation.set(-0.95, 0, 0.1);
      break;
    }
    case 'cooler': {
      part(g, PROP_GEO.box, PROP_MATS.white, 0.34, 0.28, 0.55, 0, 0, 0);
      part(g, PROP_GEO.box, PROP_MATS.blue, 0.35, 0.07, 0.56, 0, 0.16, 0);
      break;
    }
    case 'bags': {
      part(g, PROP_GEO.box, PROP_MATS.brown, 0.2, 0.28, 0.12, 0, -0.17, 0);
      part(g, PROP_GEO.box, PROP_MATS.paper, 0.17, 0.22, 0.1, 0.1, -0.2, 0.04);
      break;
    }
    case 'coffee': part(g, PROP_GEO.cyl, PROP_MATS.white, 0.032, 0.11, 0.032, 0, 0.03, 0); part(g, PROP_GEO.cyl, PROP_MATS.dark, 0.034, 0.02, 0.034, 0, 0.095, 0); break;
    case 'cone': part(g, PROP_GEO.cone, PROP_MATS.cone, 0.03, 0.12, 0.03, 0, 0.03, 0).rotation.x = Math.PI; part(g, PROP_GEO.ball, PROP_MATS.pink, 0.04, 0.04, 0.04, 0, 0.1, 0); break;
    case 'basket': part(g, PROP_GEO.box, PROP_MATS.basket, 0.5, 0.26, 0.34, 0, -0.1, 0.12); part(g, PROP_GEO.box, PROP_MATS.white, 0.4, 0.1, 0.26, 0, 0.06, 0.12); break;
    case 'suitcase': part(g, PROP_GEO.box, PROP_MATS.teal, 0.2, 0.52, 0.34, 0.02, -0.34, 0.05); break;
    case 'newspaper': part(g, PROP_GEO.box, PROP_MATS.paper, 0.4, 0.3, 0.015, 0, 0.12, 0.05).rotation.x = -0.25; break;
    case 'beer': part(g, PROP_GEO.cyl, PROP_MATS.green, 0.026, 0.2, 0.026, 0, 0.06, 0); break;
    case 'phone': break;
  }
  return g;
}

/** Where, relative to a hand, each prop is held (which hand, and an offset in the human's own frame). */
function propHold(kind: PropKind): { hand: 0 | 1; both?: boolean; dx: number; dy: number; dz: number } {
  switch (kind) {
    case 'rod': return { hand: 1, dx: 0, dy: 0, dz: 0.02 };
    case 'cooler': return { hand: 1, both: true, dx: 0, dy: 0.05, dz: 0.12 };
    case 'basket': return { hand: 1, both: true, dx: 0, dy: -0.04, dz: 0.05 };
    case 'newspaper': return { hand: 1, both: true, dx: 0, dy: 0.0, dz: 0.04 };
    case 'suitcase': return { hand: 1, dx: 0.04, dy: 0, dz: 0 };
    default: return { hand: 1, dx: 0, dy: 0, dz: 0.03 };
  }
}

// ---------------------------------------------------------------------------------------------
// The crowd
// ---------------------------------------------------------------------------------------------

export interface Figure {
  id: string;
  look: Look;
  script: Script | null;
  /** Fixed spot for a stander (a script of one `stay` would do, but this is cheaper and says what it is). */
  at: { u: number; v: number; yaw: number } | null;
  scale: number;
  prop: PropKind | null;
  rests: LifePerson['rests'];
  opts: HumanOptions;
  /** Proxy colours: legs, torso, head. */
  cols: [number, number, number];
  human: Human | null;
  propObj: THREE.Group | null;
  /** Smoothed heading (radians, three.js rotation.y), gait phase, a per-person phase for idle motion. */
  yawS: number; gait: number; ph: number; faced: boolean;
  pose: LifePose;
  /** Distance (m) to the camera this frame, and whether it is drawn as a real human. */
  d: number; real: boolean; index: number;
}

export interface PeopleSystem {
  group: THREE.Group;
  /** Build the cheap parts (proxy meshes, figure table). Cheap to call every frame. */
  ensure(): void;
  update(t: number, dt: number, cam: { x: number; y: number; z: number }, toLocal: (x: number, z: number) => [number, number]): void;
  /** For tests / debug: where everyone is, and which tier they are drawn at. */
  debug(): Array<{ id: string; u: number; v: number; tier: 'real' | 'proxy' | 'off'; stance: string }>;
  stats(): { real: number; proxies: number; built: number; total: number };
  dispose(): void;
}

const rotY = (yaw: number): number => Math.atan2(Math.cos(yaw), -Math.sin(yaw));
const angDiff = (a: number, b: number): number => ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;

/** The distant stand-in: a coloured legs/torso/head, three instanced meshes for the whole crowd. */
function makeProxies(cap: number): { group: THREE.Group; legs: THREE.InstancedMesh; torso: THREE.InstancedMesh; head: THREE.InstancedMesh; dispose(): void } {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true });
  const legG = new THREE.BoxGeometry(0.2, 0.86, 0.16).translate(0, 0.43, 0);
  // two legs as one box with a notch is not worth it at 50 m: a single slab, a little narrower than a walker's stance
  const torG = new THREE.BoxGeometry(0.4, 0.62, 0.22).translate(0, 1.17, 0);
  const hdG = new THREE.SphereGeometry(0.105, 6, 5).translate(0, 1.6, 0);
  const mk = (g: THREE.BufferGeometry): THREE.InstancedMesh => {
    const m = new THREE.InstancedMesh(g, mat, cap);
    m.count = 0; m.frustumCulled = false; m.castShadow = true;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    return m;
  };
  const legs = mk(legG), torso = mk(torG), head = mk(hdG);
  const group = new THREE.Group(); group.name = 'crowdProxies';
  group.add(legs, torso, head);
  return { group, legs, torso, head, dispose: () => { legG.dispose(); torG.dispose(); hdG.dispose(); mat.dispose(); } };
}

/** `onGrow` is told when a new figure has been added, so the cascaded-shadow sweep can register its (lazily created) materials. */
export function createPeople(npcs: readonly Npc[], baseY: number, onGrow?: (g: THREE.Group) => void): PeopleSystem {
  const group = new THREE.Group();
  group.name = 'townPeople';
  group.visible = false;
  let figs: Figure[] = [];
  let built = false;
  let proxies: ReturnType<typeof makeProxies> | null = null;
  let nBuilt = 0, lastReal = 0, lastProxy = 0;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3(), ax = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
  const restMeshes: Array<{ fig: Figure; obj: THREE.Group; r: NonNullable<LifePerson['rests']>[number] }> = [];

  const colsOf = (o: HumanOptions): [number, number, number] => [o.shorts ?? 0x334455, o.shirt ?? 0xffffff, o.skin ?? 0xd9a27f];

  function mkFigure(id: string, look: Look, i: number, extra: Partial<Figure>): Figure {
    const opts = humanOptionsFor(look, i);
    return {
      id, look, script: null, at: null, scale: 1, prop: null, rests: undefined, opts, cols: colsOf(opts), human: null, propObj: null,
      yawS: 0, gait: i * 1.7, ph: i * 2.3, faced: false, pose: newPose(), d: Infinity, real: false, index: i, ...extra,
    };
  }

  function realise(f: Figure): void {
    const h = makeHuman(f.opts);
    f.human = h; nBuilt++;
    if (f.look === 'bouncer') {
      // arms folded in front, and a bigger man than the rest: set once, `applyStance` leaves him alone
      h.group.scale.setScalar(1.12);
      h.pose(V(0.1, h.hipY + 0.3, 0.2), V(-0.1, h.hipY + 0.33, 0.22));
    } else if (f.scale !== 1) h.group.scale.setScalar(f.scale);
    if (f.prop) { f.propObj = makeProp(f.prop); f.propObj.visible = false; h.group.add(f.propObj); }
    h.group.visible = false;
    group.add(h.group);
  }

  function updateProp(f: Figure, p: LifePose): void {
    const o = f.propObj;
    if (!o || !f.human || !f.prop) return;
    const kind = f.prop;
    const shown = (kind === 'newspaper') ? p.stance === 'sit'
      : (kind === 'cone') ? (p.stance === 'sit' || p.stance === 'talk')
      : p.carrying;
    o.visible = shown;
    if (!shown) return;
    const hold = propHold(kind), hands = f.human.hands;
    const a = hands[hold.hand].position;
    if (hold.both) { const b = hands[1 - hold.hand].position; o.position.set((a.x + b.x) / 2 + hold.dx, (a.y + b.y) / 2 + hold.dy, (a.z + b.z) / 2 + hold.dz); }
    else o.position.set(a.x + hold.dx, a.y + hold.dy, a.z + hold.dz);
    if (kind === 'newspaper') o.position.y += 0.06;
  }

  return {
    group,

    ensure(): void {
      if (built) return;
      built = true;
      let i = 0;
      const fs: Figure[] = [];
      // standers: the bouncer, the smoker, the chatters, the angler. (Interior staff are made by the interior that owns them.)
      for (const n of npcs) if (!n.inside && n.at) fs.push(mkFigure(n.id, n.look, i++, { at: n.at }));
      for (const p of PEOPLE) {
        const f = mkFigure(p.id, p.look, i++, { script: p.script, scale: p.scale ?? 1, prop: p.prop ?? null, rests: p.rests });
        // a child is not the same shirt as its parent: the palette is by index, so just make sure of the scale in the proxy too
        fs.push(f);
      }
      figs = fs;
      proxies = makeProxies(figs.length);
      group.add(proxies.group);
      for (const f of figs) {
        if (!f.rests) continue;
        for (const r of f.rests) { const o = makeProp(r.kind); o.visible = false; group.add(o); restMeshes.push({ fig: f, obj: o, r }); }
      }
    },

    update(t, dt, cam, toLocal): void {
      if (!built) return;
      const [cu, cv] = toLocal(cam.x, cam.z);
      // distance to the nearest part of the street, not to its centre: the crowd is 200 m wide
      const du = Math.max(0, Math.abs(cu) - 104), dv = cv < 18 ? 18 - cv : cv > 172 ? cv - 172 : 0;
      group.visible = Math.hypot(du, dv, Math.max(0, cam.y - 40)) < PEOPLE_RANGE;
      if (!group.visible) { lastReal = 0; lastProxy = 0; return; }

      // 1. everyone's pose for this instant, and how far from the camera: a closed-form sample each, no state
      for (const f of figs) {
        const p = f.pose;
        if (f.script) sample(f.script, t, p); else { p.u = f.at!.u; p.v = f.at!.v; p.y = 0; p.yaw = f.at!.yaw; p.speed = 0; p.stance = 'stand'; p.hidden = false; p.carrying = false; p.beat = 0; p.bt = 0; }
        f.d = p.hidden ? Infinity : Math.hypot(p.u - cu, p.v - cv);
      }
      // 2. the nearest REAL_MAX inside REAL_RANGE are full humans; build at most one new one per frame
      let nReal = 0;
      const order = figs.filter((f) => f.d < REAL_RANGE).sort((a, b) => a.d - b.d);
      let builtThisFrame = false;
      for (const f of figs) f.real = false;
      for (const f of order) {
        if (nReal >= REAL_MAX) break;
        if (!f.human) { if (builtThisFrame) continue; realise(f); builtThisFrame = true; onGrow?.(f.human!.group); }
        f.real = true; nReal++;
      }
      // 3. animate the real ones; hide humans that have fallen back to a proxy
      let nProxy = 0;
      for (const f of figs) {
        const p = f.pose;
        const h = f.human;
        if (h) h.group.visible = f.real;
        if (f.real && h) {
          const g = h.group;
          const target = rotY(p.yaw);
          // smooth the heading: a corner is a turn, not a snap. A fresh figure starts facing its way.
          if (!f.faced) { f.yawS = target; f.faced = true; }
          f.yawS += angDiff(f.yawS, target) * Math.min(1, dt * 7);
          const moving = p.speed > 0.12;
          if (moving) f.gait += p.speed * dt * (p.stance === 'jog' ? 3.0 : 4.2);
          // head glances first: the stances below override the head tilt for phones and seats
          if (f.d < FACE_RANGE) h.update(t, 0);
          let yOff = (p.stance === 'sit' || p.stance === 'sitphone') ? SIT_DROP : 0;
          // beyond GAIT_RANGE a figure keeps its last pose and just slides: at 40 m that is indistinguishable from stepping
          if (f.d < GAIT_RANGE && f.look !== 'bouncer') yOff = applyStance(h, f, p, t, moving);
          g.position.set(p.u, baseY + p.y + yOff * f.scale, Zf(p.v));
          g.rotation.y = f.yawS;
          updateProp(f, p);
        } else if (!p.hidden && f.d < PROXY_RANGE && proxies) {
          // the silhouette: position, heading and scale only
          const i = nProxy++;
          pos.set(p.u, baseY + p.y, Zf(p.v));
          q.setFromAxisAngle(ax, rotY(p.yaw));
          sc.setScalar(f.scale);
          m4.compose(pos, q, sc);
          proxies.legs.setMatrixAt(i, m4); proxies.torso.setMatrixAt(i, m4); proxies.head.setMatrixAt(i, m4);
          col.setHex(f.cols[0]); proxies.legs.setColorAt(i, col);
          col.setHex(f.cols[1]); proxies.torso.setColorAt(i, col);
          col.setHex(f.cols[2]); proxies.head.setColorAt(i, col);
        }
      }
      if (proxies) {
        for (const m of [proxies.legs, proxies.torso, proxies.head]) {
          m.count = nProxy;
          m.instanceMatrix.needsUpdate = true;
          if (m.instanceColor) m.instanceColor.needsUpdate = true;
        }
      }
      // things that rest somewhere for part of a script (the cooler on the ground, then on the tailgate)
      for (const r of restMeshes) {
        const p = r.fig.pose;
        const show = !!r.fig.script && p.beat >= r.r.beats[0] && p.beat <= r.r.beats[1] && r.fig.d < PROXY_RANGE;
        r.obj.visible = show;
        if (show) r.obj.position.set(r.r.u, baseY + r.r.y + 0.16, Zf(r.r.v));
      }
      lastReal = nReal; lastProxy = nProxy;
    },

    debug: () => figs.map((f) => ({ id: f.id, u: f.pose.u, v: f.pose.v, tier: f.real ? 'real' as const : (!f.pose.hidden && f.d < PROXY_RANGE ? 'proxy' as const : 'off' as const), stance: f.pose.stance })),
    stats: () => ({ real: lastReal, proxies: lastProxy, built: nBuilt, total: figs.length }),

    dispose(): void {
      const shared = new Set<THREE.BufferGeometry>(Object.values(PROP_GEO));
      group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !shared.has(m.geometry)) m.geometry.dispose(); });
      proxies?.dispose();
      group.clear();
    },
  };
}

// Kept for the interiors, which place a person at a fixed spot and pose them: unchanged behaviour.
export interface Person { npc: Npc; human: Human; baseY: number }
export function placeStander(p: Person): void {
  const a = p.npc.at!;
  p.human.group.position.set(a.u, p.baseY, Zf(a.v));
  p.human.group.rotation.y = Math.atan2(Math.cos(a.yaw), -Math.sin(a.yaw));
}
export function makePerson(npc: Npc, index: number, baseY: number): Person {
  const human = makeHuman(humanOptionsFor(npc.look, index));
  if (npc.look === 'bouncer') {
    human.group.scale.setScalar(1.12);
    human.pose(new THREE.Vector3(0.1, human.hipY + 0.3, 0.2), new THREE.Vector3(-0.1, human.hipY + 0.33, 0.22));
  }
  const p: Person = { npc, human, baseY };
  placeStander(p);
  return p;
}

void NPCS; void PAD_Y;
