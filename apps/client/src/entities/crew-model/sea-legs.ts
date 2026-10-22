/**
 * Sea legs — how a standing body responds to the deck moving under it, layered on top of
 * whatever pose the dance clip produced this frame (dance.ts calls `updateSeaLegs` right after
 * `mixer.update`).
 *
 * The input is not "the wave height" or "the boat's pitch": it's the deck's actual acceleration
 * at the figure's own feet, finite-differenced from the figure's world position each frame. A
 * figure on the bow of a pitching boat gets the lever-arm heave of standing 5 m from the pitch
 * axis; one at the helm barely moves. Heave, pitch, roll, a hard turn and a slam off a wave all
 * arrive through that one signal, and nothing here needs to know about waves or BoatState.
 *
 * From it we form the specific force — acceleration minus gravity, expressed in the body's own
 * frame (x = the figure's left, y = up, z = forward). That's exactly what a standing person's
 * feet and inner ear sense:
 *   - its direction is the apparent vertical. A balancing human keeps their centre of mass
 *     over their feet along it, which is why sailors stay world-upright on a rolling deck and
 *     lean into a boat that's accelerating forward. → torso lean.
 *   - its magnitude over g is how heavy they feel. A deck rising into a wave loads the legs,
 *     one dropping off the back of it unloads them. → knee bend (and the hips sink with it).
 *
 * Neither response is instant. Each is a damped spring chasing its target — the lean slow and
 * a little underdamped (a person a beat late correcting, then overshooting), the knees quicker
 * and springier (legs acting as shock absorbers). The head is stabilised harder than the torso
 * (the vestibulo-collic reflex keeps gaze level), and the upper chest and arms get a light, fast,
 * underdamped spring of their own — the soft secondary motion of a relaxed body being bounced,
 * which is what reads as "the body moving with the water" rather than a rigid statue tilting.
 *
 * The rig has no soft-tissue bones (it's Mixamo's standard skeleton — see asset.ts), so all of
 * that is expressed on the existing spine/neck/head/arm/leg bones.
 *
 * `stepSeaLegs` is the pure physics (plain numbers in and out, unit-tested in
 * test/sea-legs.test.ts); `applySeaLegs` is the three.js half that turns its output into bone
 * rotations.
 */
import * as THREE from 'three';
import { clamp } from '../../core/math.js';

const G = 9.81;

// Torso posture loop: ~1.1 Hz, underdamped — visibly late and a touch of overshoot.
const LEAN_HZ = 1.1;
const LEAN_ZETA = 0.45;
// How fully the torso aligns with the apparent vertical. <1: ankles/hips are stiff enough that
// a body is partly carried along with the deck rather than perfectly world-upright.
const LEAN_COMPLIANCE = 0.85;
const LEAN_MAX = 0.4; // rad

// Legs as shock absorbers: ~1.6 Hz, springy.
const KNEE_HZ = 1.6;
const KNEE_ZETA = 0.35;
// rad of knee bend per extra g of load.
const KNEE_PER_G = 0.45;
const KNEE_MAX = 0.65;
// Sea-state brace: the rougher the recent ride, the softer the knees stay even between waves.
// `rough` is a ~2 s running mean of |deck acceleration| in m/s².
const ROUGH_TAU_S = 2;
const BRACE_PER_MS2 = 0.035;
const BRACE_MAX = 0.28;

// Chest/arm secondary spring: fast and lightly damped.
const SOFT_HZ = 3;
const SOFT_ZETA = 0.18;
const SOFT_CHEST_PER_G = 0.09; // rad of chest pitch per g of load change
const SOFT_ARM_PER_G = 0.22; // rad of arm abduction per g of unloading
const SOFT_ARM_PER_LAT = 0.03; // rad of arm swing per m/s² of sideways deck acceleration

// Head picks up this fraction of whatever lean error the torso hasn't corrected yet.
const HEAD_STABILISE = 0.6;

// Acceleration estimate: velocity and acceleration are each low-passed, since twice-
// differentiating an interpolated render position is noisy.
const VEL_TAU_S = 0.05;
const ACC_TAU_S = 0.07;
const ACC_MAX = 40; // m/s² — slams spike, a boat swap or teleport would be infinite
// Below this specific force the body is effectively in free fall (boat airborne): no apparent
// vertical to align with.
const FREEFALL_F = 3;
// Integrate springs in steps no larger than this, regardless of frame rate.
const MAX_SUBSTEP_S = 1 / 120;

interface Spring { x: number; v: number }

export interface SeaLegsState {
  /** Torso lean toward +z (forward) and toward +x (the figure's left), rad. */
  leanFwd: Spring;
  leanSide: Spring;
  /** Knee bend, rad (0 = clip pose). */
  knee: Spring;
  /** Fast secondary: chest pitch and arm abduction share one spring each. */
  softChest: Spring;
  softArm: Spring;
  softArmSide: Spring;
  /** Unfiltered lean target, kept so the head can stabilise toward it faster than the torso. */
  targetFwd: number;
  targetSide: number;
  rough: number;
  // Acceleration estimator (world space).
  hasPos: boolean;
  hasVel: boolean;
  px: number; py: number; pz: number;
  vx: number; vy: number; vz: number;
  ax: number; ay: number; az: number;
}

export function createSeaLegsState(): SeaLegsState {
  const s = (): Spring => ({ x: 0, v: 0 });
  return {
    leanFwd: s(), leanSide: s(), knee: s(), softChest: s(), softArm: s(), softArmSide: s(),
    targetFwd: 0, targetSide: 0, rough: 0,
    hasPos: false, hasVel: false, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0,
  };
}

function stepSpring(s: Spring, target: number, hz: number, zeta: number, dt: number): void {
  const w = 2 * Math.PI * hz;
  // Semi-implicit Euler — stable at these stiffnesses for dt ≤ MAX_SUBSTEP_S.
  s.v += (w * w * (target - s.x) - 2 * zeta * w * s.v) * dt;
  s.x += s.v * dt;
}

/** Low-pass blend factor for a first-order filter with time constant `tau`. */
const lp = (dt: number, tau: number): number => 1 - Math.exp(-dt / tau);

/**
 * Feeds one frame's world-space foot position into the acceleration estimator. Returns false
 * (and resets the estimator) on a discontinuity — first frame, a boat swap, a teleport — so a
 * jump never registers as a giant acceleration.
 */
export function trackFootPosition(s: SeaLegsState, x: number, y: number, z: number, dt: number): boolean {
  if (dt <= 0) return s.hasVel;
  if (!s.hasPos || Math.hypot(x - s.px, y - s.py, z - s.pz) > 3) {
    s.hasPos = true;
    s.hasVel = false;
    s.px = x; s.py = y; s.pz = z;
    s.ax = s.ay = s.az = 0;
    return false;
  }
  const rvx = (x - s.px) / dt, rvy = (y - s.py) / dt, rvz = (z - s.pz) / dt;
  s.px = x; s.py = y; s.pz = z;
  if (!s.hasVel) {
    s.hasVel = true;
    s.vx = rvx; s.vy = rvy; s.vz = rvz;
    return false;
  }
  const kv = lp(dt, VEL_TAU_S);
  const nvx = s.vx + (rvx - s.vx) * kv, nvy = s.vy + (rvy - s.vy) * kv, nvz = s.vz + (rvz - s.vz) * kv;
  const ka = lp(dt, ACC_TAU_S);
  s.ax += (clamp((nvx - s.vx) / dt, -ACC_MAX, ACC_MAX) - s.ax) * ka;
  s.ay += (clamp((nvy - s.vy) / dt, -ACC_MAX, ACC_MAX) - s.ay) * ka;
  s.az += (clamp((nvz - s.vz) / dt, -ACC_MAX, ACC_MAX) - s.az) * ka;
  s.vx = nvx; s.vy = nvy; s.vz = nvz;
  return true;
}

/**
 * Advances every spring by `dt` given the specific force (deck acceleration minus gravity, i.e.
 * `a + (0, g, 0)`) in the body frame: x = figure's left, y = up, z = forward. A figure standing
 * still on a level deck sees (0, 9.81, 0). `accMag` is |deck acceleration| for the sea-state brace.
 */
export function stepSeaLegs(s: SeaLegsState, fx: number, fy: number, fz: number, accMag: number, dt: number): void {
  if (dt <= 0) return;
  const fMag = Math.hypot(fx, fy, fz);
  const grounded = fMag > FREEFALL_F && fy > 0;

  const targetFwd = grounded ? clamp(Math.atan2(fz, fy) * LEAN_COMPLIANCE, -LEAN_MAX, LEAN_MAX) : 0;
  const targetSide = grounded ? clamp(Math.atan2(fx, fy) * LEAN_COMPLIANCE, -LEAN_MAX, LEAN_MAX) : 0;
  s.targetFwd = targetFwd;
  s.targetSide = targetSide;

  s.rough += (accMag - s.rough) * lp(dt, ROUGH_TAU_S);
  const brace = Math.min(BRACE_MAX, s.rough * BRACE_PER_MS2);
  // Load along the body's own up axis. In free fall the legs reach for the deck (extend fully).
  const load = grounded ? fy / G : 0;
  const kneeTarget = clamp(brace + (load - 1) * KNEE_PER_G, 0, KNEE_MAX);

  const softChestTarget = clamp((load - 1) * SOFT_CHEST_PER_G, -0.15, 0.15);
  const softArmTarget = clamp((1 - load) * SOFT_ARM_PER_G, -0.12, 0.35);
  // Arms are left behind by sideways deck acceleration: the deck accelerating toward +x leaves
  // them swinging toward -x relative to the body. fx carries that (and gravity from roll).
  const softArmSideTarget = clamp(-fx * SOFT_ARM_PER_LAT, -0.25, 0.25);

  const n = Math.max(1, Math.ceil(dt / MAX_SUBSTEP_S));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    stepSpring(s.leanFwd, targetFwd, LEAN_HZ, LEAN_ZETA, h);
    stepSpring(s.leanSide, targetSide, LEAN_HZ, LEAN_ZETA, h);
    stepSpring(s.knee, kneeTarget, KNEE_HZ, KNEE_ZETA, h);
    stepSpring(s.softChest, softChestTarget, SOFT_HZ, SOFT_ZETA, h);
    stepSpring(s.softArm, softArmTarget, SOFT_HZ, SOFT_ZETA, h);
    stepSpring(s.softArmSide, softArmSideTarget, SOFT_HZ, SOFT_ZETA, h);
  }
  // Springs can overshoot their targets; the joints can't.
  s.knee.x = clamp(s.knee.x, 0, KNEE_MAX);
  s.leanFwd.x = clamp(s.leanFwd.x, -LEAN_MAX, LEAN_MAX);
  s.leanSide.x = clamp(s.leanSide.x, -LEAN_MAX, LEAN_MAX);
}

// --- three.js half -------------------------------------------------------------------------

export interface SeaLegsRig {
  root: THREE.Object3D;
  /** The figure root's resting y in its parent (the deck height at its slot). */
  restY: number;
  spine: THREE.Object3D[]; // Spine, Spine1, Spine2
  neck: THREE.Object3D | null;
  head: THREE.Object3D | null;
  upLeg: THREE.Object3D[]; // L, R
  leg: THREE.Object3D[];
  foot: THREE.Object3D[];
  leftArm: THREE.Object3D | null;
  rightArm: THREE.Object3D | null;
  /** Last frame's clip pose (`pre`) and what we turned it into (`post`), per edited bone. See
   * `restoreClipPose`. */
  applied: Map<THREE.Object3D, { pre: THREE.Quaternion; post: THREE.Quaternion }>;
}

/** GLTFLoader strips the ':' from Mixamo's `mixamorig:Spine` (three's PropertyBinding sanitises
 * node names); match on the bare bone name either way. */
function findBone(root: THREE.Object3D, name: string): THREE.Object3D | null {
  let hit: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (!hit && o.name.replace(/^mixamorig:?/, '') === name) hit = o;
  });
  return hit;
}

export function createSeaLegsRig(root: THREE.Object3D): SeaLegsRig {
  const req = (n: string): THREE.Object3D[] => {
    const b = findBone(root, n);
    return b ? [b] : [];
  };
  return {
    root,
    restY: root.position.y,
    spine: [...req('Spine'), ...req('Spine1'), ...req('Spine2')],
    neck: findBone(root, 'Neck'),
    head: findBone(root, 'Head'),
    upLeg: [...req('LeftUpLeg'), ...req('RightUpLeg')],
    leg: [...req('LeftLeg'), ...req('RightLeg')],
    foot: [...req('LeftFoot'), ...req('RightFoot')],
    leftArm: findBone(root, 'LeftArm'),
    rightArm: findBone(root, 'RightArm'),
    applied: new Map(),
  };
}

const _deckQ = new THREE.Quaternion();
const _invDeckQ = new THREE.Quaternion();
const _yawQ = new THREE.Quaternion();
const _foot = new THREE.Vector3();
const _f = new THREE.Vector3();
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisZ = new THREE.Vector3(0, 0, 1);
const _tmpQ = new THREE.Quaternion();
const _parentQ = new THREE.Quaternion();
const _d = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** Mean height of the feet in the root's parent space (i.e. relative to the deck). */
function footHeight(rig: SeaLegsRig, parent: THREE.Object3D): number {
  if (!rig.foot.length) return 0;
  let y = 0;
  for (const f of rig.foot) {
    f.updateWorldMatrix(true, false);
    y += parent.worldToLocal(_v.setFromMatrixPosition(f.matrixWorld)).y;
  }
  return y / rig.foot.length;
}

/** Rotation of `bone` relative to `root`, from local quaternions only (bone world matrices are
 * stale between mixer.update and render). The rig's only scale is uniform, so this is exact. */
function rootSpaceQuat(bone: THREE.Object3D, root: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
  out.identity();
  for (let o: THREE.Object3D | null = bone; o && o !== root; o = o.parent) out.premultiply(o.quaternion);
  return out;
}

/**
 * Puts back the clip's pose on any bone the mixer didn't rewrite this frame. three's
 * PropertyMixer only writes a bone when its sampled value changed since the last write — so once
 * the dance eases to a stop (timeScale 0, every time the boat gets going), the mixer leaves our
 * previous edit in place and the next edit would stack on top of it, frame after frame. A bone
 * still holding exactly what we wrote last frame was not touched by the mixer.
 */
function restoreClipPose(rig: SeaLegsRig): void {
  for (const [bone, a] of rig.applied) {
    if (bone.quaternion.equals(a.post)) bone.quaternion.copy(a.pre);
  }
}

interface Edit { bone: THREE.Object3D; delta: THREE.Quaternion; orig: THREE.Quaternion }
const _edits: Edit[] = [];
const _pool: Edit[] = [];

function queue(bone: THREE.Object3D | null, delta: THREE.Quaternion, root: THREE.Object3D): void {
  if (!bone) return;
  const e = _pool[_edits.length] ?? (_pool[_edits.length] = { bone, delta: new THREE.Quaternion(), orig: new THREE.Quaternion() });
  e.bone = bone;
  e.delta.copy(delta);
  rootSpaceQuat(bone, root, e.orig); // snapshot before any edit touches its parents
  _edits.push(e);
}

/** Rotation by `ax` about X then `az` about Z, in root (body) space. */
function bodyRot(ax: number, az: number, out: THREE.Quaternion): THREE.Quaternion {
  out.setFromAxisAngle(_axisX, ax);
  return out.premultiply(_tmpQ.setFromAxisAngle(_axisZ, az));
}

/**
 * Measures the deck under `rig.root`, steps the physics and poses the bones. Call after
 * mixer.update and after dance.ts sets the root's own rotation. `restRotY` is the slot's yaw —
 * the body frame is the deck rotated by it, not the root (whose lean is cosmetic).
 * `armWeight` scales the arm secondary motion down while the clip is driving the arms hard.
 */
export function applySeaLegs(rig: SeaLegsRig, s: SeaLegsState, restRotY: number, dt: number, armWeight: number): void {
  const root = rig.root;
  const parent = root.parent;
  if (!parent) return;

  parent.updateWorldMatrix(true, false);
  _foot.set(root.position.x, rig.restY, root.position.z).applyMatrix4(parent.matrixWorld);
  const live = trackFootPosition(s, _foot.x, _foot.y, _foot.z, dt);

  parent.getWorldQuaternion(_deckQ).multiply(_yawQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, restRotY));
  _invDeckQ.copy(_deckQ).invert();
  if (live) {
    _f.set(s.ax, s.ay + G, s.az).applyQuaternion(_invDeckQ);
    stepSeaLegs(s, _f.x, _f.y, _f.z, Math.hypot(s.ax, s.ay, s.az), dt);
  }

  const fwd = s.leanFwd.x, side = s.leanSide.x, knee = s.knee.x;
  // Leaning toward +z is a rotation about +x by +angle (y→z); toward +x is about +z by −angle.
  // A crouch also pitches the torso forward a little to keep the hips' mass over the feet.
  const torsoFwd = fwd + knee * 0.45;

  restoreClipPose(rig);
  root.position.y = rig.restY;
  const footBefore = footHeight(rig, parent);
  _edits.length = 0;
  const d = _d;
  const spineShare = [0.35, 0.65, 0.9];
  rig.spine.forEach((b, i) => {
    const chest = i === rig.spine.length - 1 ? s.softChest.x : 0;
    queue(b, bodyRot(torsoFwd * spineShare[i] + chest, -side * spineShare[i], d), root);
  });
  const headFwd = fwd + (s.targetFwd - fwd) * HEAD_STABILISE + s.softChest.x * 0.5;
  const headSide = side + (s.targetSide - side) * HEAD_STABILISE;
  queue(rig.neck, bodyRot((torsoFwd + headFwd) * 0.5 + s.softChest.x, -(side + headSide) * 0.5, d), root);
  queue(rig.head, bodyRot(headFwd, -headSide, d), root);
  // Knees forward: thigh tips its lower end toward +z (about +x by −knee), shin back the other
  // way (+knee), foot stays as the clip had it so it remains flat on the deck.
  for (const b of rig.upLeg) queue(b, bodyRot(-knee, 0, d), root);
  for (const b of rig.leg) queue(b, bodyRot(knee, 0, d), root);
  for (const b of rig.foot) queue(b, d.identity(), root);
  const armUp = s.softArm.x * armWeight, armSwing = s.softArmSide.x * armWeight;
  // Abduction: the left arm (+x side) lifts about +z, the right about −z; the sideways swing
  // moves both the same way.
  queue(rig.leftArm, d.setFromAxisAngle(_axisZ, armUp + armSwing), root);
  queue(rig.rightArm, d.setFromAxisAngle(_axisZ, -armUp + armSwing), root);

  // Parents were queued before children, so each parent's new rotation is in place by the time
  // its child solves for a local rotation that lands it at `delta * orig` in body space.
  for (const e of _edits) {
    const target = _tmpQ.copy(e.delta).multiply(e.orig);
    const p = e.bone.parent;
    if (p && p !== root) rootSpaceQuat(p, root, _parentQ).invert();
    else _parentQ.identity();
    let a = rig.applied.get(e.bone);
    if (!a) rig.applied.set(e.bone, (a = { pre: new THREE.Quaternion(), post: new THREE.Quaternion() }));
    a.pre.copy(e.bone.quaternion);
    e.bone.quaternion.copy(_parentQ.multiply(target));
    a.post.copy(e.bone.quaternion);
  }

  // Bending the knees draws the feet up toward the hips; sink the whole body by however far they
  // actually rose (measured, not a straight-leg formula — the clip's legs are rarely straight) so
  // they stay planted on the deck. Any lift the clip itself has (a dance step) is preserved.
  root.position.y = rig.restY - (footHeight(rig, parent) - footBefore);
}
