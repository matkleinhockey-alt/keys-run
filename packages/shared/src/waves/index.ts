/**
 * Deep-water wave field: amplitude envelope, sea states, and the 8-component wave sum.
 *
 * Ported faithfully from legacy/index.html lines 433-441 and 445-447. Every magic number and
 * evaluation order is preserved exactly.
 *
 * ⚠ KNOWN LANDMINE (see docs/ARCHITECTURE.md "must never import three.js"): legacy's `waveH`
 * (index.html:442-444) is `return amp*h + wakeH(x,z,t);` — `wakeH` reads `wakeP`, an array of
 * `THREE.Vector4` holding boat wake rings. That put three.js inside the single most-shared
 * function in the codebase. `waveHBase` below is ONLY the pure sum loop (index.html:443) with
 * the `+ wakeH(...)` term removed. `wakeH`/`wakeP`/`emitWake` stay in legacy/index.html —
 * they are client-only rendering state and a later phase (the client app) re-adds them on top
 * of `waveHBase`, i.e. `waveH = waveHBase + wakeH`.
 *
 * `SW`/`CH` (swell/chop scalars) were legacy module-level mutable `let`s
 * (index.html:435, changed by the player cycling sea states) that `waveH`/`waveSlope` read via
 * closure. A pure shared function cannot read hidden mutable globals, so they are now explicit,
 * optional parameters defaulting to legacy's initial values (`SW=.9, CH=1`) — calling
 * `waveHBase(x,z,t,amp)` with no sea-state args reproduces the original formula exactly. A
 * later phase (the client, and the server's 2-DOF shadow model) passes live sea-state values.
 */

import { clamp } from '../internal/math.js';

/** [kx, kz, angular speed (deep-water dispersion), amplitude, crest sharpness, phase, swell?] */
export type WaveComponent = [number, number, number, number, number, number, number];

// each wave: direction (kx,kz), angular speed w, amplitude A, crest sharpness c; rollers travel north from the Atlantic
export const WAVES: WaveComponent[] = [
  [0.0114, 0.0262, 0.53, 0.62, 0.12, 0, 1], [0.0302, 0.0322, 0.66, 0.32, 0.16, 1.7, 1], [0.074, 0.046, 0.93, 0.13, 0.28, 2.4, 0], [-0.052, 0.092, 1.02, 0.09, 0.25, 0.6, 0],
  [0.0205, 0.0178, 0.516, 0.45, 0.1, 3.1, 1], [-0.0128, 0.0251, 0.526, 0.35, 0.1, 4.4, 1], [0.118, 0.071, 1.162, 0.06, 0.3, 1.1, 0], [-0.09, 0.13, 1.244, 0.05, 0.3, 5.2, 0],
];

export interface SeaState {
  n: string;
  sw: number;
  ch: number;
  d: string;
}

// sea state: rolling ground swell plus local wind chop
export const SEA_STATES: SeaState[] = [
  { n: 'Calm', sw: 0.8, ch: 0.5, d: 'a long, lazy ground swell.' },
  { n: 'Choppy', sw: 1.3, ch: 1.2, d: 'steady swells with afternoon chop on top.' },
  { n: 'Haulover', sw: 1.6, ch: 2.2, d: 'steep, stacked inlet chop. Trim up and hang on.' },
  { n: 'Big swell', sw: 2.6, ch: 1.1, d: 'big Atlantic rollers. Ride the backs and watch the troughs.' },
];

/** Legacy's initial `SW`/`CH` (index.html:435), used as `waveHBase`/`waveSlope`'s defaults. */
export const DEFAULT_SW = 0.9;
export const DEFAULT_CH = 1;

/** small inshore, big rollers in deep blue water */
export const ampFor = (d: number): number => 0.1 + 0.9 * clamp((d - 1) / 40, 0, 1) + 1 * clamp((d - 45) / 250, 0, 1);

/**
 * The pure 8-component deep-water wave sum (legacy `waveH`, index.html:442-443) with the wake
 * term removed. See the module doc comment above for why.
 */
export function waveHBase(x: number, z: number, t: number, amp: number, sw = DEFAULT_SW, ch = DEFAULT_CH): number {
  let h = 0;
  for (let i = 0; i < 8; i++) {
    const W = WAVES[i], p = W[0] * x + W[1] * z + W[2] * t + W[5], A = W[3] * (W[6] ? sw : Math.min(ch, 2.2));
    h += A * (Math.sin(p) - W[4] * Math.cos(2 * p));
  }
  return amp * h;
}

/** Surface gradient of the same wave sum (legacy `waveSlope`, index.html:445-447). */
export function waveSlope(x: number, z: number, t: number, amp: number, sw = DEFAULT_SW, ch = DEFAULT_CH): [number, number] {
  let hx = 0, hz = 0;
  for (let i = 0; i < 8; i++) {
    const W = WAVES[i], p = W[0] * x + W[1] * z + W[2] * t + W[5], A = W[3] * (W[6] ? sw : Math.min(ch, 2.2)), d = Math.cos(p) + 2 * W[4] * Math.sin(2 * p);
    hx += A * W[0] * d; hz += A * W[1] * d;
  }
  return [amp * hx, amp * hz];
}
