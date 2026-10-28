/**
 * The channel markers: a red nun and a green can down each side of every dredged cut.
 *
 * Placement is `@keysrun/shared/world/channel-marks` — pure data, so where a mark stands is
 * testable without a renderer. This module is only the geometry, and it follows
 * `game/race/buoys.ts`'s approach for the same reason that file gives: one `InstancedMesh` per
 * part rather than a group per buoy, so fifty marks cost a handful of draw calls.
 *
 * Shape carries the meaning as much as colour does, which is the point of the lateral system: a
 * red mark is a nun (conical) and a green one is a can (flat-topped cylinder), so the pair is
 * still readable at a distance where both have washed out to grey, and to anyone who cannot
 * separate the two colours. Each carries a reflective band, a radar reflector, a short mast and
 * a light that comes up at dusk.
 *
 * ## Floating, rather than being drawn at the water's height
 *
 * The first version set each buoy's Y from `sample(x, z)` and gave it a lean computed from its
 * own x and z — a fixed tilt per buoy, the same on flat water as in a four-foot sea. It rode up
 * and down and never heeled, which reads as a cone on a lift rather than a thing floating.
 *
 * Two changes fix that, and both fall out of asking the water rather than the clock:
 *
 *  - **It leans to the SLOPE.** The surface normal comes from finite-differencing the same
 *    height function two metres either side, so a buoy heels downhill off a crest exactly as a
 *    float does. The sampler already includes the player's wake, so this is also the whole of
 *    "move with the wake": drive past a mark and it rolls away from you as the wake arrives and
 *    rights itself behind it, with no wake-specific code anywhere in here.
 *  - **It has MASS.** Heave is a spring-damper toward the water rather than an assignment, so the
 *    buoy lags into a trough, hangs a moment on a crest and never perfectly matches the surface;
 *    the lean is smoothed the same way, because a ballasted buoy rights itself over about a
 *    second rather than instantly. Chain-moored buoys also turn slowly on the tide, so each one
 *    carries a little yaw drift of its own.
 */
import * as THREE from 'three';
import { channelMarks, type ChannelMark } from '@keysrun/shared/world/channel-marks';

export interface ChannelBuoys {
  group: THREE.Group;
  marks: readonly ChannelMark[];
  /** Ride the swell. `sample(x, z)` is the water height under that point, wake included. */
  update(dt: number, sample: (x: number, z: number) => number): void;
  /** VERIFICATION ONLY: the float state of mark `i`. */
  debug(i: number): { y: number; vy: number; leanX: number; leanZ: number; tiltDeg: number };
}

// Bigger than the real thing, for the same reason game/race/buoys.ts gives: a 1 m buoy is a
// pixel at the range you first need to see it, and a mark you only notice once you are level
// with it has not marked anything. Still small enough beside a 9 m hull to read as a buoy.
const BODY_R = 1.3;
const BODY_H = 3.2;
const MAST_H = 3.2;

/**
 * How far either side to sample the surface for the slope, metres.
 *
 * About the buoy's own beam. Much smaller and it picks up the shortest ripples in the wave sum
 * and jitters; much larger and it averages the swell it is supposed to be riding into a flat.
 */
export const SLOPE_SPAN = 2.2;

/**
 * Radians of lean per unit of surface gradient.
 *
 * This was 9 — a huge exaggeration, and an honest one at the time. The wave field had no energy
 * below 40 m of wavelength, so the gradient a 2.2 m buoy could see was 0.008 inshore and 0.016
 * offshore: half a degree and one degree of heel. Lying exactly parallel to the water, which is
 * already the upper bound since a ballasted buoy stands MORE upright than the slope, produced
 * nothing that read as floating, so the lean was scaled up until it did.
 *
 * Short wind chop (@keysrun/shared/waves' CHOP) removed the reason. The same measurement now
 * reads 0.033 inshore and 0.047 offshore in a calm, 0.077 and 0.111 in a chop — four to eight
 * times what it was. At a gain of 9 the buoy sat pinned against `MAX_LEAN` in seven of nine
 * sea-state-and-location combinations, including ordinary inshore chop, and a buoy permanently
 * heeled to its stop reads as broken rather than afloat.
 *
 * 1.5 puts it back where the old number was aiming: about 3 degrees in a calm inshore, 7 in a
 * chop, 14 in deep water, 22 at Haulover, and still room under the clamp for a wake to knock it
 * further. It is also nearly honest now — barely above lying parallel to real water.
 */
export const LEAN_GAIN = 1.5;

/** Hard stop on the lean, as the tangent of the tilt. A buoy knocked past about 28 degrees reads
 * as capsizing rather than as riding. */
export const MAX_LEAN = 0.53;

/** Heave spring (rad/s)^2 and damping ratio. Underdamped, so it overshoots a little coming off a
 * crest — which is the part that reads as buoyancy rather than as following a curve. */
const HEAVE_K = 24;
const HEAVE_ZETA = 0.62;

/** How fast the lean chases the slope, 1/s. A ballasted buoy rights over about a second. */
const LEAN_RATE = 4.5;

interface Float {
  y: number;
  vy: number;
  /** Smoothed surface gradient, as the x/z components of the up vector. */
  lx: number;
  lz: number;
  spin: number;
  spinV: number;
  inited: boolean;
}

export function createChannelBuoys(marks: readonly ChannelMark[] = channelMarks()): ChannelBuoys {
  const group = new THREE.Group();
  group.name = 'channelBuoys';

  const reds = marks.filter((m) => m.hand === 'red');
  const greens = marks.filter((m) => m.hand === 'green');

  // A nun is conical, a can is a flat drum — the silhouette is half the signal.
  const nunGeo = new THREE.ConeGeometry(BODY_R, BODY_H, 9);
  const canGeo = new THREE.CylinderGeometry(BODY_R, BODY_R, BODY_H * 0.78, 9);
  const redMat = new THREE.MeshStandardMaterial({ color: 0xb8322a, roughness: 0.62, metalness: 0.05 });
  const greenMat = new THREE.MeshStandardMaterial({ color: 0x1f7a46, roughness: 0.62, metalness: 0.05 });
  const mastMat = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.7, metalness: 0.2 });
  // Retroreflective tape, and the galvanised radar reflector above it. Both are what you actually
  // pick out first — the tape at night under a spotlight, the reflector as the bright hard edge
  // against the sky by day.
  const tapeMat = new THREE.MeshStandardMaterial({ color: 0xe8edf0, roughness: 0.28, metalness: 0.35 });
  const reflMat = new THREE.MeshStandardMaterial({ color: 0xa8b2ba, roughness: 0.35, metalness: 0.75, flatShading: true });

  const nun = new THREE.InstancedMesh(nunGeo, redMat, Math.max(1, reds.length));
  const can = new THREE.InstancedMesh(canGeo, greenMat, Math.max(1, greens.length));
  const mastGeo = new THREE.CylinderGeometry(0.1, 0.12, MAST_H, 6);
  const mast = new THREE.InstancedMesh(mastGeo, mastMat, Math.max(1, marks.length));
  const tapeGeo = new THREE.CylinderGeometry(BODY_R * 1.02, BODY_R * 1.02, 0.42, 9, 1, true);
  const tape = new THREE.InstancedMesh(tapeGeo, tapeMat, Math.max(1, marks.length));
  const reflGeo = new THREE.OctahedronGeometry(0.46, 0);
  const refl = new THREE.InstancedMesh(reflGeo, reflMat, Math.max(1, marks.length));
  for (const m of [nun, can, mast, tape, refl]) { m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false; group.add(m); }

  // Lights, lit by the same additive-sprite trick the rigs use. Red over red, green over green,
  // so a mark reads the same way at night as it does by day.
  const lightTex = makeGlow();
  const lights = marks.map((m) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: lightTex, color: m.hand === 'red' ? 0xff5a4a : 0x4affa0,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55,
    }));
    sp.scale.setScalar(1.6);
    group.add(sp);
    return sp;
  });

  // Deterministic per-mark spin: same marks, same idle turn, every session.
  const floats: Float[] = marks.map((m, i) => ({
    y: 0, vy: 0, lx: 0, lz: 0,
    spin: ((Math.sin(m.x * 0.013 + i) * 0.5 + 0.5) * Math.PI * 2),
    spinV: Math.sin(m.z * 0.017 + i * 1.7) * 0.09,
    inited: false,
  }));

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _qs = new THREE.Quaternion();
  const _s = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3(), _n = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  function update(dt: number, sample: (x: number, z: number) => number): void {
    // The spring is explicit, so a long frame (a stall, a tab coming back) must not be integrated
    // in one step or it detonates. Capped at a couple of frames' worth.
    const h = Math.min(0.05, Math.max(0, dt));
    const damp = 2 * Math.sqrt(HEAVE_K) * HEAVE_ZETA;
    const leanK = 1 - Math.exp(-LEAN_RATE * h);
    let ri = 0, gi = 0;

    for (let i = 0; i < marks.length; i++) {
      const k = marks[i], f = floats[i];
      const surf = sample(k.x, k.z);
      if (!f.inited) { f.y = surf; f.inited = true; }

      // Heave with mass, not an assignment.
      f.vy += ((surf - f.y) * HEAVE_K - f.vy * damp) * h;
      f.y += f.vy * h;

      // The slope, from the same height function. Central differences across the buoy's own beam.
      const gx = (sample(k.x + SLOPE_SPAN, k.z) - sample(k.x - SLOPE_SPAN, k.z)) / (2 * SLOPE_SPAN);
      const gz = (sample(k.x, k.z + SLOPE_SPAN) - sample(k.x, k.z - SLOPE_SPAN)) / (2 * SLOPE_SPAN);
      let tx = -gx * LEAN_GAIN, tz = -gz * LEAN_GAIN;
      const mag = Math.hypot(tx, tz);
      if (mag > MAX_LEAN) { const c = MAX_LEAN / mag; tx *= c; tz *= c; }
      f.lx += (tx - f.lx) * leanK;
      f.lz += (tz - f.lz) * leanK;
      f.spin += f.spinV * h;

      _n.set(f.lx, 1, f.lz).normalize();
      _q.setFromUnitVectors(UP, _n);
      _q.multiply(_qs.setFromAxisAngle(UP, f.spin));

      const body = k.hand === 'red' ? nun : can;
      const idx = k.hand === 'red' ? ri++ : gi++;
      // Every part hangs off the same tilted axis, so the whole mark heels as one object.
      const place = (up: number, mesh: THREE.InstancedMesh, slot: number): void => {
        _p.set(k.x + f.lx * up, f.y + up, k.z + f.lz * up);
        mesh.setMatrixAt(slot, _m.compose(_p, _q, _s));
      };
      place(BODY_H * 0.34, body, idx);
      place(BODY_H * 0.34, tape, i);
      place(BODY_H * 0.55 + MAST_H * 0.5, mast, i);
      place(BODY_H * 0.55 + MAST_H * 0.86, refl, i);
      const lampUp = BODY_H * 0.55 + MAST_H;
      lights[i].position.set(k.x + f.lx * lampUp, f.y + lampUp, k.z + f.lz * lampUp);
    }
    for (const m of [nun, can, mast, tape, refl]) m.instanceMatrix.needsUpdate = true;
    nun.count = reds.length; can.count = greens.length;
    mast.count = marks.length; tape.count = marks.length; refl.count = marks.length;
  }

  return {
    group,
    marks,
    update,
    debug(i) {
      const f = floats[i] ?? floats[0];
      return {
        y: +f.y.toFixed(3), vy: +f.vy.toFixed(3),
        leanX: +f.lx.toFixed(4), leanZ: +f.lz.toFixed(4),
        tiltDeg: +(Math.atan(Math.hypot(f.lx, f.lz)) * 180 / Math.PI).toFixed(2),
      };
    },
  };
}

/** Small radial glow, same idea as the rigs' lamp sprites. */
function makeGlow(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}
