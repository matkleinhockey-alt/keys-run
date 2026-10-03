/**
 * Independent oracle for the boat-trajectory fidelity test (boat-trajectory.test.ts).
 *
 * Follows the pattern set by packages/shared/test/generate-golden.mjs: read legacy/index.html,
 * slice out the *original* source lines for the physics functions under test, and evaluate
 * that extracted source with `new Function(...)`. It does NOT import `@keysrun/shared/sim/boat`
 * (the hand-written port being tested) — it is built straight from the legacy file, so it
 * can't accidentally pass by sharing a bug with the port.
 *
 * Extracted verbatim, unmodified:
 *  - index.html:440-460   WAVES, waveH (wave sum + wake), waveSlope, emitWake, wakeH
 *  - index.html:799-800   PGRID/PCELL, addPillar
 *  - index.html:1727-1737 dockCollide
 *  - index.html:3869-3888 autoChaseControl
 *  - index.html:3890-3892 slam
 *  - index.html:3897-3984 updateBoat
 *
 * What's NOT extracted, and why: `depthAt`/`landH` (world/chain + world/depth) and `depthFast`/
 * `ampAt` (sim/depth-grid) are reused from the already-built, already golden-tested
 * `@keysrun/shared` package rather than re-extracted here. Those are independently verified
 * against this exact same legacy file in packages/shared/test/*.test.ts; re-extracting them
 * again here would just duplicate that proof, not strengthen it. What IS newly hand-written in
 * `packages/shared/src/sim/boat.ts` — the buoyancy/trim/collision/wake *composition* in
 * `stepBoat`, plus the plain-array `wakeHeight`/`emitWakeInto` standing in for legacy's
 * `THREE.Vector4` wake ring — has no shared code with this oracle at all.
 *
 * Dependencies this file supplies that are NOT extracted from legacy (clearly separated from
 * the verbatim blocks above): `toast`/`AUD`/`cam`/`spawnP` no-ops (legacy's DOM/three.js/audio
 * side effects, deliberately dropped — see docs/ARCHITECTURE.md and boat.ts's doc comment),
 * `rand` (legacy's `a+Math.random()*(b-a)` helper, only ever used by the now-no-op spray in
 * `slam`), and `game`/`F`/`LUIGI` stand-ins for systems out of Phase 0's scope (fishing,
 * Luigi mode) that `updateBoat` reads but this test doesn't exercise.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { depthAt, landH, WB } from '@keysrun/shared/world/depth';
import { depthFast, ampAt } from '@keysrun/shared/sim/depth-grid';
import { SPEED_SCALE } from '@keysrun/shared/content/boats';

// Not extracted from legacy (trivial one-liners; legacy/index.html:323) — `internal/math.ts` is
// deliberately not part of @keysrun/shared's public subpath exports, so this oracle (like the
// client) defines its own copy rather than reaching into the package's internals.
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_PATH = path.resolve(HERE, '../../../legacy/index.html');
const SRC_LINES = fs.readFileSync(LEGACY_PATH, 'utf8').split('\n');
/** 1-indexed, inclusive, like generate-golden.mjs's `slice`. */
const slice = (a: number, b: number): string => SRC_LINES.slice(a - 1, b).join('\n');

function assertPure(label: string, src: string): void {
  // Same intent as generate-golden.mjs's assertPure, minus 'THREE' (we DO expect one `new
  // THREE.Vector4` call site inside the extracted 440-460 block — see the shim in buildBody).
  const banned = ['document.', 'window.', 'fetch('];
  for (const token of banned) {
    if (src.includes(token)) {
      throw new Error(`boat-oracle: extracted block "${label}" unexpectedly contains "${token}" — not pure, investigate before trusting this oracle.`);
    }
  }
}

const WAVE_BLOCK = slice(440, 460);
assertPure('waves+wake (index.html:440-460)', WAVE_BLOCK);
const PGRID_BLOCK = slice(799, 800);
assertPure('PGRID/addPillar (index.html:799-800)', PGRID_BLOCK);
const DOCK_COLLIDE_BLOCK = slice(1727, 1737);
assertPure('dockCollide (index.html:1727-1737)', DOCK_COLLIDE_BLOCK);
const AUTO_CHASE_BLOCK = slice(3869, 3888);
assertPure('autoChaseControl (index.html:3869-3888)', AUTO_CHASE_BLOCK);
const SLAM_BLOCK = slice(3890, 3892);
assertPure('slam (index.html:3890-3892)', SLAM_BLOCK);
const UPDATE_BOAT_BLOCK = slice(3897, 3984);
assertPure('updateBoat (index.html:3897-3984)', UPDATE_BOAT_BLOCK);

// Sanity-check the slice boundaries so a future legacy edit can't silently desync this oracle.
if (!UPDATE_BOAT_BLOCK.startsWith('function updateBoat(dt,t){') || !UPDATE_BOAT_BLOCK.trim().endsWith('}')) {
  throw new Error('boat-oracle: index.html:3897-3984 no longer matches the expected updateBoat body — legacy file changed underneath this oracle.');
}
if (!AUTO_CHASE_BLOCK.startsWith('function autoChaseControl(topMs,canDrive){')) {
  throw new Error('boat-oracle: index.html:3869-3888 no longer matches autoChaseControl — legacy file changed underneath this oracle.');
}
if (!DOCK_COLLIDE_BLOCK.startsWith('function dockCollide(nx,nz,fx,fz,S,t){')) {
  throw new Error('boat-oracle: index.html:1727-1737 no longer matches dockCollide — legacy file changed underneath this oracle.');
}

export interface OracleHull {
  len: number;
  beam: number;
  top: number;
  accel: number;
  turn: number;
  draft: number;
  cat?: boolean;
}

export interface OracleControls {
  fwd: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  trimUp: boolean;
  trimDn: boolean;
  gear: 'D' | 'N' | 'R';
  engineOn: boolean;
  trimMode: boolean;
  autoChaseEnabled: boolean;
}

export interface OraclePiling {
  x: number;
  z: number;
  old?: boolean;
  r?: number;
}

export interface OracleDockRect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface OracleSnapshot {
  x: number;
  z: number;
  h: number;
  speed: number;
  thr: number;
  steer: number;
  y: number;
  pitch: number;
  roll: number;
  air: boolean;
  trimV: number;
  trimVent: number;
}

interface OracleApi {
  setEnv(sw: number, ch: number, dockRects: OracleDockRect[], pilings: OraclePiling[]): void;
  setControls(c: OracleControls): void;
  step(dt: number, t: number): OracleSnapshot;
}

interface OracleDeps {
  depthAt: (x: number, z: number) => number;
  landH: (x: number, z: number) => number;
  depthFast: (x: number, z: number) => number;
  ampAt: (x: number, z: number) => number;
  clamp: (v: number, a: number, b: number) => number;
  lerp: (a: number, b: number, t: number) => number;
  SPEED_SCALE: number;
  WB: { x0: number; x1: number; z0: number; z1: number };
  startX: number;
  startZ: number;
  startH: number;
  hull: OracleHull;
}

function buildBody(): string {
  return `
'use strict';
const { depthAt, landH, depthFast, ampAt, clamp, lerp, SPEED_SCALE, WB, startX, startZ, startH, hull } = deps;

// --- minimal THREE.Vector4 shim: a plain data holder with a .set(), nothing else. The
// extracted wake-ring block (index.html:450) only ever calls "new THREE.Vector4(...)" and
// "vector.set(...)" on it — no three.js maths is used on wakeP entries.
const THREE = { Vector4: class Vector4 {
  constructor(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
} };

// --- stand-ins for systems out of Phase 0's scope / three.js+DOM side effects (NOT extracted
// from legacy; see this file's module doc comment).
function toast() {}
const AUD = { slam() {} };
const cam = { shake: 0 };
function spawnP() {}
function rand(a, b) { return a + Math.random() * (b - a); }
const game = { running: true };
const F = { state: 'idle', fx: 0, fz: 0, running: false };
const LUIGI = { on: false };
function lineOut() { return false; }

// --- mutable control/world state the extracted functions close over (legacy module-level lets).
let boatSpec = hull;
let autoChase = true, acMsgT = 0, collideMsgT = 0, slamT = 0;
let SW = 0.9, CH = 1;
const GEAR = { g: 'D', rev: 0 };
const TRIM = { mode: false, v: 0.2, up: false, dn: false, vent: 0, msgT: 0 };
const ENGINE = { on: true, startT: -1 };
const input = { fwd: false, back: false, left: false, right: false, action: false };
let DOCK_RECTS = [];
let boat = {
  x: startX, z: startZ, h: startH, vy: 0, vp: 0, vr: 0, air: false, speed: 0, thr: 0, steer: 0,
  y: 0, pitch: 0, roll: 0, dvx: 0, dvz: 0, wakeAcc: 0, wakeT: 0, warnT: 0, autoOn: false, autoMode: '',
  model: { props: [], flags: null, outboards: null, wheel: null, tower: null, group: { position: { set() {} }, rotation: { set() {} } } },
};

// --- verbatim from legacy/index.html (see this file's doc comment for exact line ranges) ---
${WAVE_BLOCK}
${PGRID_BLOCK}
${DOCK_COLLIDE_BLOCK}
${AUTO_CHASE_BLOCK}
${SLAM_BLOCK}
${UPDATE_BOAT_BLOCK}
// --- end verbatim block ---

return {
  setEnv(sw, ch, dockRects, pilings) {
    SW = sw; CH = ch;
    DOCK_RECTS = dockRects;
    PGRID.clear();
    pilings.forEach(addPillar);
  },
  setControls(c) {
    input.fwd = c.fwd; input.back = c.back; input.left = c.left; input.right = c.right;
    TRIM.up = c.trimUp; TRIM.dn = c.trimDn; TRIM.mode = c.trimMode;
    GEAR.g = c.gear; ENGINE.on = c.engineOn; autoChase = c.autoChaseEnabled;
  },
  step(dt, t) {
    updateBoat(dt, t);
    return { x: boat.x, z: boat.z, h: boat.h, speed: boat.speed, thr: boat.thr, steer: boat.steer,
      y: boat.y, pitch: boat.pitch, roll: boat.roll, air: boat.air, trimV: TRIM.v, trimVent: TRIM.vent };
  },
};
`;
}

const BODY = buildBody();

/** Builds one independent oracle boat, starting at rest at (x,z,h) with the given hull spec. */
export function createBoatOracle(hull: OracleHull, x: number, z: number, h: number): OracleApi {
  const deps: OracleDeps = { depthAt, landH, depthFast, ampAt, clamp, lerp, SPEED_SCALE, WB, startX: x, startZ: z, startH: h, hull };
  const factory = new Function('deps', BODY) as (d: OracleDeps) => OracleApi;
  return factory(deps);
}
