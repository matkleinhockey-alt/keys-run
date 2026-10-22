/**
 * Rod flex: a damped spring on the rod's bend, driven by the fight's line load.
 *
 * Why a spring and not `bend = tension * k` (what this was): a rod is an energy store. Load it and
 * the tip goes down and *stays* down; take the load away suddenly (the fish gives line, the hook
 * pulls, the leader parts) and the stored energy comes back as a recoil that overshoots straight
 * and rings for a few cycles. A static map has no velocity, so it can show neither the bolt that
 * yanks the tip down nor the whip-back on a lost fish, which is exactly what made the old rod
 * read as a stick on a hinge. Tuned underdamped (zeta 0.32, omega 24 rad/s: ~4 Hz, the ring of a
 * 7 ft medium-heavy) - heavier damping read as rubber, lighter as a diving board.
 *
 * Two bends share this solver: the first-person view model and the third-person rod on the boat
 * (whose stock mesh is one rigid cylinder, so `worldRodFor` swaps in a segmented one).
 *
 * The bend plane is not fixed: the tip bends toward the fish, because the line pulls the tip
 * toward wherever the fish is. (Rod axis = local +y; rotating by +a about x moves the tip toward
 * +z, by -a about z toward +x, so a unit direction (ux,uz) in the rod's own frame gives
 * rot.x = a*uz, rot.z = -a*ux.)
 */
import * as THREE from 'three';
import { clamp } from '../../core/math.js';
import { F } from './state.js';

/** Per-segment bend (rad) at full load, before the taper weights below. Total curl of the 5-piece
 * rod at T=1 is BEND_MAX * sum(SEG_K) ~ 0.21 * 4.2 = 0.88 rad (50 degrees): a rod working hard,
 * not folded in half. (0.3 was tried first and read as a hairpin from the first-person angle,
 * where the curl is foreshortened and the tip appears to double back on itself.) */
export const BEND_MAX = 0.21;
/** Weight of each segment's share of the curl: the butt barely moves, the tip does most of it
 * (a parabolic action). Index 0 is the rigid handle section. */
export const SEG_K: readonly number[] = [0, 0.55, 0.85, 1.2, 1.6];
const OMEGA = 24;
const ZETA = 0.32;
/** Negative bend = tip thrown back past straight (the recoil lobe). */
const BEND_MIN = -0.14;
const BEND_CAP = 0.45;

export interface Flex {
  /** Current bend, same units as BEND_MAX. */
  x: number;
  v: number;
  /** Smoothed unit direction to the fish in the rod's local xz plane. */
  ux: number;
  uz: number;
  t: number;
}

export function createFlex(): Flex { return { x: 0, v: 0, ux: 0, uz: -1, t: 0 }; }

/** Where the bend wants to be right now, from the fight/line state in `F`. */
export function bendTarget(fx: Flex): number {
  const f = F.fight;
  if (F.state === 'fight' && f) {
    const T = clamp(f.tension, 0, 1.2);
    // Saturating: the first lb loads the tip a lot, the last barely - a loaded rod stiffens.
    let b = BEND_MAX * (1 - Math.exp(-2.4 * T)) / (1 - Math.exp(-2.4));
    // A slipping clutch makes the whole rod sing at the drag's strike rate.
    if (f.slipping) b += 0.012 * Math.min(1, Math.abs(f.lineSpeed) / 6) * Math.sin(fx.t * 70);
    b += f.shake * 0.06 * Math.sin(fx.t * 41); // head shakes
    return b;
  }
  if (F.state === 'bite') return 0.07;
  if (F.state === 'nibble') return F.dipT > 0 ? 0.035 : 0.012;
  return 0.008;
}

/** Semi-implicit Euler, sub-stepped: the fixed step is ~33 ms, a quarter of the ring period. */
export function stepFlex(fx: Flex, dt: number, target: number): void {
  fx.t += dt;
  const n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n;
  for (let i = 0; i < n; i++) {
    fx.v += (OMEGA * OMEGA * (target - fx.x) - 2 * ZETA * OMEGA * fx.v) * h;
    fx.x += fx.v * h;
    if (fx.x > BEND_CAP) { fx.x = BEND_CAP; fx.v = Math.min(0, fx.v); }
    else if (fx.x < BEND_MIN) { fx.x = BEND_MIN; fx.v = Math.max(0, fx.v); }
  }
}

/** A transient load (bolt, head shake, jump landing): yanks the tip down. */
export function kickFlex(fx: Flex, mag: number): void { fx.v += mag * 3.2; }
/** The load vanished (hook pulled, line parted, fish gave line): whips the tip back. */
export function recoilFlex(fx: Flex, load: number): void { fx.v -= clamp(load, 0, 1.2) * 9; }

const tmp = new THREE.Vector3();
/** Point the bend plane at `world` (the fish or bobber), in `frame`'s local axes. */
export function aimFlex(fx: Flex, frame: THREE.Object3D, wx: number, wy: number, wz: number, dt: number): void {
  frame.updateWorldMatrix(true, false);
  tmp.set(wx, wy, wz);
  frame.worldToLocal(tmp);
  let ux = tmp.x, uz = tmp.z;
  const l = Math.hypot(ux, uz);
  if (l < 1e-3) { ux = 0; uz = -1; } else { ux /= l; uz /= l; }
  const k = Math.min(1, dt * 10);
  fx.ux += (ux - fx.ux) * k;
  fx.uz += (uz - fx.uz) * k;
}

/** The same parabolic curl spread over n segments (sums to the 5-piece rod's total), so the
 * third-person rod can use more, shorter pieces and look like a curve rather than a polyline. */
export function segWeights(n: number): number[] {
  const w = Array.from({ length: n }, (_, i) => Math.pow(i / (n - 1), 1.4));
  const total = SEG_K.reduce((a, b) => a + b, 0), sum = w.reduce((a, b) => a + b, 0);
  return w.map((x) => (x * total) / sum);
}

export function applyFlex(segs: readonly THREE.Object3D[], fx: Flex, weights: readonly number[] = SEG_K): void {
  for (let i = 1; i < segs.length; i++) {
    const a = fx.x * (weights[i] ?? 1.6);
    segs[i].rotation.x = a * fx.uz;
    segs[i].rotation.z = -a * fx.ux;
  }
}

/** Fish (or bobber) position in world space, whichever the line is currently tied to. */
export function lineTarget(out: THREE.Vector3): THREE.Vector3 {
  if (F.state === 'fight') return out.set(F.fx, 0, F.fz);
  return out.set(F.bob.x, F.bob.y, F.bob.z);
}

export interface WorldRod {
  segs: THREE.Group[];
  tip: THREE.Object3D;
  flex: Flex;
  weights: number[];
}

const worldRods = new WeakMap<THREE.Object3D, WorldRod>();
const WSEG = 8, WSEGL = 3 / WSEG;

/**
 * The third-person rod, made bendable. The boat model ships one rigid 3 m cylinder
 * (entities/boat/model.ts); hiding it and parenting an 8-piece chain to the same pivot keeps that
 * file untouched. Same silhouette (0.04 -> 0.018 m taper over 3 m, now 8 pieces), so nothing visibly changes
 * until the rod is loaded. The returned `tip` replaces `model.rodTip` as the line's anchor, since
 * the real tip now moves with the curl.
 */
export function worldRodFor(model: { rodPivot: THREE.Group }): WorldRod {
  const piv = model.rodPivot;
  const hit = worldRods.get(piv);
  if (hit) return hit;
  const stock = piv.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh && (c.geometry as THREE.CylinderGeometry).parameters?.height === 3);
  if (stock) stock.visible = false;
  const mat = stock?.material ?? new THREE.MeshStandardMaterial({ color: 0x1c1f24 });
  const segs: THREE.Group[] = [];
  let parent: THREE.Object3D = piv;
  for (let i = 0; i < WSEG; i++) {
    const sg = new THREE.Group();
    if (i > 0) sg.position.y = WSEGL;
    parent.add(sg);
    const r0 = 0.04 - (0.022 / WSEG) * i, r1 = r0 - 0.022 / WSEG;
    sg.add(new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, WSEGL, 6).translate(0, WSEGL / 2, 0), mat));
    segs.push(sg);
    parent = sg;
  }
  const tip = new THREE.Object3D();
  tip.position.y = WSEGL;
  parent.add(tip);
  const wr: WorldRod = { segs, tip, flex: createFlex(), weights: segWeights(WSEG) };
  worldRods.set(piv, wr);
  return wr;
}
