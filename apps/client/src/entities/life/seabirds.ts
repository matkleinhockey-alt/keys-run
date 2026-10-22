/**
 * Seabirds: gulls and terns over the bait, frigatebirds over the weeds, brown pelicans cruising
 * the shallows, and Caelen (a gull). Each bird is a vertex-coloured body plus two-part wings
 * (shoulder + elbow) so it can flap, glide, bank into turns and fold up to dive.
 *
 * Ported faithfully from legacy/index.html:1977-2034 (`mergeColored`, `BIRD_KINDS`, `birdGeos`,
 * `makeSeabird`, `poseBird`, `moveBird`). Shared by pelicans.ts, hotspots.ts (bait-ball birds +
 * weedline frigatebirds) and caelen.ts.
 */
import * as THREE from 'three';
import { clamp, lerp } from '../../core/math.js';

function mergeColored(parts: ReadonlyArray<readonly [THREE.BufferGeometry, number]>): THREE.BufferGeometry {
  let n = 0;
  const gs = parts.map(([g, c]): [THREE.BufferGeometry, THREE.Color] => {
    const ng = g.index ? g.toNonIndexed() : g;
    ng.computeVertexNormals();
    n += ng.attributes.position.count;
    return [ng, new THREE.Color(c)];
  });
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  gs.forEach(([g, c]) => {
    pos.set((g.attributes.position as THREE.BufferAttribute).array as Float32Array, o * 3);
    nor.set((g.attributes.normal as THREE.BufferAttribute).array as Float32Array, o * 3);
    for (let i = 0; i < g.attributes.position.count; i++) { col[(o + i) * 3] = c.r; col[(o + i) * 3 + 1] = c.g; col[(o + i) * 3 + 2] = c.b; }
    o += g.attributes.position.count;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

const BIRD_MAT = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide, flatShading: true });

export type BirdKind = 'gull' | 'tern' | 'frigate' | 'pelican';

interface BirdKindDef {
  span: number; body: number; bodyC: number; wingC: number; tipC: number; headC: number; beakC: number;
  tail: 'square' | 'fork' | 'deepfork'; tailC: number; neck: number; pelican?: boolean; angular?: boolean;
}

const BIRD_KINDS: Record<BirdKind, BirdKindDef> = {
  gull: { span: 1.25, body: 0.42, bodyC: 0xf6f6f3, wingC: 0xaeb5bc, tipC: 0x1b1d20, headC: 0xf8f8f6, beakC: 0xe2b23a, tail: 'square', tailC: 0xf6f6f3, neck: 0 },
  tern: { span: 0.95, body: 0.34, bodyC: 0xf8f8f6, wingC: 0xd3d8dd, tipC: 0x8a9096, headC: 0x15171a, beakC: 0xe4572e, tail: 'fork', tailC: 0xf8f8f6, neck: 0 },
  frigate: { span: 2.1, body: 0.55, bodyC: 0x16181c, wingC: 0x1b1d22, tipC: 0x111216, headC: 0x16181c, beakC: 0x8a8f96, tail: 'deepfork', tailC: 0x16181c, neck: 0, angular: true },
  pelican: { span: 2.1, body: 0.85, bodyC: 0x6f6556, wingC: 0x5d5448, tipC: 0x2a2622, headC: 0xf2e6c4, beakC: 0xc9a25a, tail: 'square', tailC: 0x5d5448, neck: 1, pelican: true },
};

interface BirdGeos { body: THREE.BufferGeometry; inner: THREE.BufferGeometry; outer: THREE.BufferGeometry; ei: number }
const BIRD_GEO: Partial<Record<BirdKind, BirdGeos>> = {};

function birdGeos(kind: BirdKind): BirdGeos {
  const cached = BIRD_GEO[kind];
  if (cached) return cached;
  const K = BIRD_KINDS[kind], L = K.body;
  const sph = (r: number, sx: number, sy: number, sz: number, x: number, y: number, z: number): THREE.BufferGeometry => {
    const g = new THREE.SphereGeometry(r, 10, 7);
    g.scale(sx, sy, sz); g.translate(x, y, z);
    return g;
  };
  const parts: Array<[THREE.BufferGeometry, number]> = [[sph(L * 0.5, 0.42, 0.4, 1, 0, 0, 0), K.bodyC]];
  if (K.pelican) {
    parts.push([sph(L * 0.16, 1, 1, 1, 0, 0.1, L * 0.42), K.headC]);
    const b = new THREE.ConeGeometry(0.045, L * 0.7, 6); b.rotateX(Math.PI / 2); b.translate(0, 0.08, L * 0.8);
    parts.push([b, K.beakC]);
    parts.push([sph(0.05, 1, 0.9, 3.2, 0, 0.03, L * 0.72), 0xb08d5a]);
    parts.push([sph(L * 0.11, 1, 1.3, 1, 0, 0.05, L * 0.3), K.headC]);
  } else {
    parts.push([sph(L * 0.17, 1, 0.95, 1.1, 0, 0.03, L * 0.52), K.headC]);
    const b = new THREE.ConeGeometry(0.022, L * 0.32, 6); b.rotateX(Math.PI / 2); b.translate(0, 0.02, L * 0.78);
    parts.push([b, K.beakC]);
  }
  // tail
  const tl = new THREE.Shape(), tw = L * 0.22, tlen = K.tail === 'deepfork' ? L * 0.9 : K.tail === 'fork' ? L * 0.55 : L * 0.32;
  if (K.tail === 'square') { tl.moveTo(-tw * 0.5, 0); tl.lineTo(tw * 0.5, 0); tl.lineTo(tw * 0.6, -tlen); tl.lineTo(-tw * 0.6, -tlen); }
  else { tl.moveTo(-tw * 0.5, 0); tl.lineTo(tw * 0.5, 0); tl.lineTo(tw * 0.7, -tlen); tl.lineTo(0, -tlen * 0.45); tl.lineTo(-tw * 0.7, -tlen); }
  const tg = new THREE.ShapeGeometry(tl); tg.rotateX(-Math.PI / 2); tg.translate(0, 0, -L * 0.42);
  parts.push([tg, K.tailC]);
  // wings: inner panel from shoulder to elbow, outer panel (hand) from elbow to tip with dark tips
  const s = K.span / 2, ei = s * 0.46, chord = L * (K.pelican ? 0.55 : 0.42);
  const inner = new THREE.Shape();
  inner.moveTo(0, chord * 0.55); inner.lineTo(ei, chord * 0.45); inner.lineTo(ei, -chord * 0.5); inner.lineTo(0, -chord * 0.45);
  const outer = new THREE.Shape();
  const eo = s - ei, sweep = K.angular ? chord * 0.5 : chord * 0.2;
  outer.moveTo(0, chord * 0.45); outer.lineTo(eo * 0.7, chord * 0.2 - sweep * 0.5); outer.lineTo(eo, -sweep); outer.lineTo(eo * 0.75, -chord * 0.35 - sweep * 0.4); outer.lineTo(0, -chord * 0.5);
  const tip = new THREE.Shape();
  tip.moveTo(eo * 0.62, chord * 0.24 - sweep * 0.45); tip.lineTo(eo, -sweep); tip.lineTo(eo * 0.8, -chord * 0.32 - sweep * 0.4); tip.lineTo(eo * 0.62, -chord * 0.3 - sweep * 0.3);
  const flat = (g: THREE.BufferGeometry): THREE.BufferGeometry => { g.rotateX(-Math.PI / 2); return g; };
  const iG = mergeColored([[flat(new THREE.ShapeGeometry(inner)), K.wingC]]);
  const tipG = flat(new THREE.ShapeGeometry(tip)); tipG.translate(0, 0.003, 0);
  const oG = mergeColored([[flat(new THREE.ShapeGeometry(outer)), K.wingC], [tipG, K.tipC]]);
  return BIRD_GEO[kind] = { body: mergeColored(parts), inner: iG, outer: oG, ei };
}

/**
 * A bird that has been startled off (by a gunshot) or struck. It is kept as a plain offset applied
 * inside `moveBird`, the one function every bird system (pelicans, hotspots, weedlines, Caelen's
 * neighbours, the boat gulls) already calls to place a bird each frame - so scattering needs no
 * cooperation from those systems and cannot fight them: they keep computing the bird's "home"
 * position and `moveBird` shifts it. See `scareBird`.
 */
export interface BirdFlee {
  /** Seconds since the scare. */
  t: number;
  /** Seconds the bird stays away in total (it flies off, is gone, and flies back). */
  away: number;
  /** Unit horizontal direction it runs, away from whatever scared it. */
  dx: number; dz: number;
}

/** Seconds of visible flight each way (out, and back in) before the bird is out of sight. */
export const FLEE_FLIGHT_S = 4;

/**
 * A bird that has been shot and is on its way down — the same trick as `BirdFlee`: a plain state
 * bag honoured inside `moveBird`, so none of the systems that own birds (boat-gulls, pelicans,
 * the bait-ball and weedline flocks) needs to know this can happen.
 *
 * Unlike a flee, a fall IGNORES the home position `moveBird` is handed. A falling bird is no
 * longer following its flock's path at an offset; it is a ballistic object. So the fall carries
 * its own integrated position and `moveBird` places the bird there outright.
 */
export interface BirdFall {
  /** Live world position of the tumbling body. */
  x: number; y: number; z: number;
  /** Velocity, m/s. Seeded from the bird's own flight so it carries on through, not straight down. */
  vx: number; vy: number; vz: number;
  /** Tumble angle and rate, radians / radians per second. */
  spin: number;
  spinRate: number;
  /** Water surface Y at the moment of the hit, snapshotted by the caller. Within the metre or two
   * of wave relief over a 1-2 s fall this is close enough, and it keeps `moveBird` — which has no
   * idea what a wave is — from needing the wave field. */
  surf: number;
  /** Seconds the flock is a bird down before a replacement drifts back in — see `moveBird`'s
   * fall-lands branch for why the bird is recycled rather than destroyed. Supplied by the caller
   * so the number can live next to the carcass lifetime it has to outlast. */
  awayS: number;
  /** Called once, by `moveBird`, the frame the body reaches the water. This is where a carcass
   * gets spawned. A callback rather than a flag someone polls because `moveBird` is the only code
   * that knows the falling position, and the owner of the carcass list (entities/life/carcass.ts)
   * is not the owner of the bird. */
  onSplash: (x: number, y: number, z: number) => void;
}

/** Terminal-ish fall speed, m/s. A gull is light and mostly feathers; it flutters down rather
 * than dropping like a stone, which is also the funnier reading. */
const FALL_MAX_SPEED = 13;
/** Gravity used for the tumble, m/s². Under the real 9.81 to stretch the fall out — the arc is the
 * whole point of the moment, and at 3 fps a true 1.2 s drop is four frames of nothing. */
const FALL_G = 6.5;

export interface Bird {
  g: THREE.Group;
  wings: ReadonlyArray<{ sx: number; sh: THREE.Group; el: THREE.Group }>;
  kind: BirdKind;
  ph: number;
  px: number | null; py: number | null; pz: number | null;
  yaw: number; roll: number;
  /** Ad hoc dive-state bag — shape differs per caller (pelicans/hotspots), kept loosely typed
   * like legacy's dynamically-added `B.dive`. */
  dive: Record<string, number> | null;
  /** Non-null while scattered; see `BirdFlee`. */
  flee: BirdFlee | null;
  /** Non-null while falling out of the sky; see `BirdFall`. Takes precedence over `flee`. */
  fall: BirdFall | null;
}

/** legacy `makeSeabird` (index.html:2016-2022). */
export function makeSeabird(kind: BirdKind, scale = 1): Bird {
  const G = birdGeos(kind);
  const g = new THREE.Group();
  const body = new THREE.Mesh(G.body, BIRD_MAT);
  body.castShadow = true;
  g.add(body);
  const wings = ([-1, 1] as const).map((sx) => {
    const sh = new THREE.Group();
    sh.position.set(sx * 0.06, 0.03, 0.03);
    g.add(sh);
    const inn = new THREE.Mesh(G.inner, BIRD_MAT); inn.scale.x = sx; inn.castShadow = true; sh.add(inn);
    const el = new THREE.Group(); el.position.x = sx * G.ei; sh.add(el);
    const out = new THREE.Mesh(G.outer, BIRD_MAT); out.scale.x = sx; out.castShadow = true; el.add(out);
    return { sx, sh, el };
  });
  g.scale.setScalar(scale);
  return { g, wings, kind, ph: Math.random() * 6.28, px: null, py: null, pz: null, yaw: 0, roll: 0, dive: null, flee: null, fall: null };
}

/**
 * Wings limp and half-folded, dropped below the shoulder line. The pose of a bird that has stopped
 * flying — used while one is falling out of the sky (`poseBird` below) and again for the carcass
 * floating afterwards (entities/life/carcass.ts), which is why it is here and exported rather than
 * written twice: the two have to match or the carcass visibly changes shape the moment it lands.
 */
export function poseBirdLimp(B: Bird): void {
  B.wings.forEach((w) => {
    w.sh.rotation.set(0, -w.sx * 0.25, w.sx * -0.35);
    w.el.rotation.set(0, -w.sx * 0.55, w.sx * -0.5);
  });
}

/** legacy `poseBird` (index.html:2024-2029): flap (0..1 blend) with a phase, glide with a slight
 * dihedral, or fold back for a dive. */
export function poseBird(B: Bird, dt: number, flap: number, tuck: number, rate = 9): void {
  // A bird falling out of the sky is not flying. A flapping corpse would undo the whole read of
  // the moment.
  if (B.fall) { poseBirdLimp(B); return; }
  // A bird that has been scared is flapping hard whatever its home behaviour says (a gliding gull
  // does not coast away from a gunshot), and is not tucked for a dive.
  if (B.flee && B.g.visible) { flap = 1; tuck = 0; rate = Math.max(rate, 14); }
  B.ph += dt * rate * Math.max(0.15, flap);
  const f = Math.sin(B.ph), f2 = Math.sin(B.ph - 0.7);
  B.wings.forEach((w) => {
    const up = (0.12 + f * 0.75 * flap) * (1 - tuck) + 0.35 * tuck;
    const hand = (0.05 + f2 * 0.55 * flap) * (1 - tuck) - 0.25 * tuck;
    w.sh.rotation.set(0, -w.sx * 1.15 * tuck, w.sx * up);
    w.el.rotation.set(0, -w.sx * 0.9 * tuck, w.sx * (hand - up * 0.25));
  });
}

/** legacy `moveBird` (index.html:2031-2034): face along its motion and bank into turns. */
export function moveBird(B: Bird, x: number, y: number, z: number, dt: number): void {
  // A shot bird: ballistic, and the home position it was handed is ignored entirely (see
  // `BirdFall`). Checked before `flee` because a fall supersedes a scare.
  if (B.fall) {
    const f = B.fall;
    f.vy = Math.max(-FALL_MAX_SPEED, f.vy - FALL_G * dt);
    // Horizontal drag: it carries on along its old line for a moment and then stops driving.
    const keep = Math.max(0, 1 - dt * 1.1);
    f.vx *= keep; f.vz *= keep;
    f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
    f.spin += f.spinRate * dt;
    B.g.visible = true;
    B.g.position.set(f.x, f.y, f.z);
    // Nose down and rolling over and over. The heading is frozen at whatever it was flying: it is
    // no longer steering, and re-deriving a yaw from the fall would make it weathervane.
    B.g.rotation.set(-0.9 + Math.sin(f.spin * 0.7) * 0.3, B.yaw, f.spin, 'YXZ');
    if (f.y <= f.surf) {
      B.fall = null;
      // The body is gone from the bird system the instant it lands: what floats from here is a
      // carcass (entities/life/carcass.ts), spawned by this callback, which has its own mesh and
      // its own lifetime. The bird itself goes into a long `flee` instead of being destroyed —
      // the flocks are fixed-size pools built once at boot (boat-gulls.ts, pelicans.ts,
      // hotspots.ts), so permanently removing members would thin every flock in the world one
      // shot at a time until the sky was empty. A replacement drifts back in later, which is also
      // what the hit toast has always promised ("It will be back").
      B.g.visible = false;
      B.px = null; B.py = null; B.pz = null;
      // `t: FLEE_FLIGHT_S` starts the absence already past the outbound leg, so a dead bird does
      // not fly away from its own splash — only the return leg at the far end still plays.
      B.flee = { t: FLEE_FLIGHT_S, away: Math.max(f.awayS, 2 * FLEE_FLIGHT_S + 1), dx: Math.sin(B.yaw), dz: Math.cos(B.yaw) };
      f.onSplash(f.x, f.surf, f.z);
    }
    return;
  }
  if (B.flee) {
    const f = B.flee;
    f.t += dt;
    if (f.t >= f.away) {
      // Home again. Forget the previous position so the heading/bank logic below does not read the
      // jump back from "far away" as a violent turn.
      B.flee = null; B.g.visible = true; B.px = null; B.py = null; B.pz = null;
    } else {
      // k is how far into the departure (or, mirrored, the return) the bird is. An accelerating run
      // (a startled gull is gone in a couple of seconds) that climbs as it goes; the return is the
      // same curve played backwards, so a bird that comes back flies back IN rather than popping.
      const k = Math.min(f.t, f.away - f.t);
      if (k >= FLEE_FLIGHT_S) { B.g.visible = false; B.px = null; return; }
      const run = 7 * k + 5 * k * k, climb = 2.5 * k + 1.2 * k * k;
      x += f.dx * run; z += f.dz * run; y += climb;
      B.g.visible = true;
    }
  }
  if (B.px !== null && B.py !== null && B.pz !== null) {
    const vx = x - B.px, vz = z - B.pz, sp = Math.hypot(vx, vz);
    if (sp > 1e-4) {
      const yaw = Math.atan2(vx, vz), dy = ((yaw - B.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      B.yaw += dy * Math.min(1, dt * 6);
      B.roll = lerp(B.roll, clamp(-dy / Math.max(dt, 1e-3) * 0.05, -0.9, 0.9), Math.min(1, dt * 3));
    }
    const pitch = Math.atan2(-(y - B.py), Math.max(0.01, Math.hypot(x - B.px, z - B.pz)));
    B.g.rotation.set(clamp(pitch, -1.3, 1.3), B.yaw, B.roll, 'YXZ');
  }
  B.g.position.set(x, y, z);
  B.px = x; B.py = y; B.pz = z;
}

const _wp = new THREE.Vector3();

/** True when the bird, and everything it is parented to, is actually drawn right now. */
export function birdShown(B: Bird): boolean {
  for (let o: THREE.Object3D | null = B.g; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/** The bird's position in world space (updates matrices up its parent chain first, because most
 * birds are children of a hotspot group and the last rendered matrixWorld is a frame old). */
export function birdWorldPos(B: Bird, out: THREE.Vector3 = _wp): THREE.Vector3 {
  B.g.updateWorldMatrix(true, false);
  return B.g.getWorldPosition(out);
}

/**
 * Sends a bird off, away from `(fromX, fromZ)`, for `awayS` seconds. Does nothing to a bird that is
 * already away (a second shot must not extend or reset the first bird's flight, or one flock
 * under fire would never come home). The run direction is taken in world space; every parent group
 * of a bird in this game is translated but not rotated, so world and local directions agree.
 */
/**
 * Shoots a bird out of the sky: it goes limp, tumbles down along the line it was flying, and when
 * it reaches the water `onSplash` fires once with the WORLD position of the impact.
 *
 * Does nothing to a bird that is already falling or already away — the same discipline as
 * `scareBird`, and for a sharper reason here: two hits on one gull must not put two carcasses in
 * the water from one bird.
 *
 * ## The coordinate space, which is the whole trick in this function
 *
 * `moveBird` writes `B.g.position`, which is PARENT-LOCAL: most birds in this game are children
 * of a hotspot/flock group that is translated (never rotated — see `scareBird`). So the fall has
 * to be integrated in local space or the bird teleports to the world origin's neighbourhood the
 * moment it is hit. Callers, meanwhile, only have world numbers: a surface height from the wave
 * field, and a splash point they want to put a carcass at. This function is the one place that
 * knows both, so it takes and returns world and converts at the boundary — the parent's
 * translation is exactly `worldPos - B.g.position`.
 */
export function shootDownBird(B: Bird, surfaceWorldY: number, awayS: number, onSplash: (x: number, y: number, z: number) => void): void {
  if (B.fall || B.flee) return;
  const w = birdWorldPos(B);
  const l = B.g.position;
  const ox = w.x - l.x, oy = w.y - l.y, oz = w.z - l.z;
  // It keeps some of its own momentum — a bird hit in level flight pitches over and carries on for
  // a beat — but only some: a full cruising speed carried all the way down read as a controlled
  // glide rather than a fall. Forward is (sin yaw, cos yaw), `moveBird`'s own convention.
  const fwd = 3.5;
  B.fall = {
    x: l.x, y: l.y, z: l.z,
    vx: Math.sin(B.yaw) * fwd, vy: -1.5, vz: Math.cos(B.yaw) * fwd,
    spin: 0, spinRate: (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 3),
    surf: surfaceWorldY - oy,
    awayS,
    onSplash: (lx, ly, lz) => onSplash(lx + ox, ly + oy, lz + oz),
  };
}

export function scareBird(B: Bird, fromX: number, fromZ: number, awayS: number): void {
  // `B.fall` as well as `B.flee`: the report of the shot that killed a bird reaches every bird in
  // earshot including that one, and a corpse must not change its mind and fly off.
  if (B.flee || B.fall) return;
  const p = birdWorldPos(B);
  let dx = p.x - fromX, dz = p.z - fromZ;
  const l = Math.hypot(dx, dz);
  if (l < 1e-3) { dx = Math.sin(B.yaw); dz = Math.cos(B.yaw); } else { dx /= l; dz /= l; }
  B.flee = { t: 0, away: Math.max(awayS, 2 * FLEE_FLIGHT_S + 1), dx, dz };
}
