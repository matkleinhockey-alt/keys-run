/**
 * Swim-cycle displacement — bake-time half of legacy `addSwimAttrs` (index.html:2425-2438).
 *
 * Legacy computed, per vertex, a lateral (`wig`) or vertical (`wigY`) displacement amplitude and
 * a per-vertex phase offset (`wph`), then uploaded all three as live vertex attributes read every
 * frame by `addSwimShader`'s `sin(uSwimT*7.5 + ipos... - wph)`. That is exactly the function this
 * module evaluates — but instead of shipping `wig`/`wigY`/`wph` to the GPU as per-vertex
 * attributes to be fed through `sin()` every frame for every vertex of every instance, `vat.ts`
 * samples this same function at `frameCount` evenly spaced phases *once*, here, on the CPU, and
 * bakes the result into a texture (docs/ARCHITECTURE.md "Fish at realism *and* density" —
 * "bake the swim cycle into a texture"). The live per-frame cost drops to one (two, with linear
 * blending) texture read per vertex instead of a sine evaluation, and the per-vertex attribute
 * count drops from three (`wig`,`wigY`,`wph`) to zero — see vat.ts.
 *
 * `scl`/`shn` (legacy's per-vertex scale-pattern scale and fresnel-shine strength) are *not*
 * baked or even kept as attributes: legacy filled them with `new Float32Array(n).fill(...)`, a
 * single constant per geometry, so they are plain material uniforms here (`uScl`/`uShn` in
 * materials.ts) instead of a wasted per-vertex buffer.
 */
import * as THREE from 'three';
import type { CreatureVis } from '@keysrun/shared/content/creatures';
import { SHAPE } from '@keysrun/shared/content/creatures';
import { clamp } from '../../core/math.js';
import type { SwimAxis } from './types.js';

export interface SwimProfile {
  axis: SwimAxis;
  /** Baked-cycle angular speed, rad/s of `uSwimT` — legacy's `uSwimT*7.5` for the lateral (x)
   * axis, or `(uSwimT*7.5)*0.55` for the vertical (y) axis (see vat.ts's header for the period
   * algebra that makes both axes loop seamlessly over one baked cycle). */
  angSpeed: number;
  /** Per-vertex displacement amplitude along `axis` (legacy `wig` or `wigY`). */
  amp: Float32Array;
  /** Per-vertex phase shift *as seen by the baked cycle* — legacy `wph`, pre-multiplied by 0.55
   * for the vertical axis to match `angSpeed`'s pre-multiplication (see vat.ts). */
  phase: Float32Array;
  /** Material uniform values (legacy per-vertex `scl`/`shn`, constant across one geometry). */
  uScl: number;
  uShn: number;
}

export const SWIM_ANG_BASE = 7.5;

/**
 * How a fish swims, not just how hard.
 *
 * Every lateral swimmer used the same wave: the body started bending 28% back, the envelope was
 * always the same square law, the wavelength was always the same 2.6 radians, and the tail beat
 * at 7.5 rad/s whatever the animal was. A 0.3 m lookdown and a 3.6 m blue marlin therefore beat
 * their tails at exactly the same 1.19 Hz, and a tuna — an animal whose whole body is a rigid
 * strut built to hold still while the tail does the work — undulated like a bonefish.
 *
 * Fish are classified by how much of the body goes into the stroke, and the differences are
 * large and easy to see:
 *
 *  - **thunniform** (tunas, billfish, wahoo, the lamnid sharks): the body is held nearly rigid
 *    and the motion is confined to the peduncle and that stiff crescent tail. The fastest mode
 *    in the ocean, and the least visibly wobbly.
 *  - **carangiform** (jacks, snappers, most reef fish): the back half works.
 *  - **subcarangiform** (bonefish, snook, barracuda, most sharks): more of the body again.
 *  - **anguilliform** (eels, and the nearest thing this world has to them): the whole animal is
 *    the wave, with more than a full wavelength on the body at once.
 *
 * `u0` is where the bend starts (body fraction from the nose), `exp` how sharply it grows from
 * there, `k` the wavenumber in radians across the body, `ampK` peak displacement as a fraction
 * of length, and `beat` a multiplier on the size-derived tail rate below.
 */
export type SwimMode = 'thunniform' | 'carangiform' | 'subcarangiform' | 'anguilliform';

interface ModeShape { u0: number; exp: number; k: number; ampK: number; beat: number }

const MODES: Readonly<Record<SwimMode, ModeShape>> = {
  // Stiff body, short sharp taper into the tail, well under half a wave on the body, and a fast
  // low-amplitude beat — exactly the signature of a tuna.
  thunniform:    { u0: 0.62, exp: 2.6, k: 1.7, ampK: 0.055, beat: 1.35 },
  carangiform:   { u0: 0.42, exp: 2.0, k: 3.0, ampK: 0.090, beat: 1.0 },
  subcarangiform:{ u0: 0.26, exp: 1.7, k: 4.2, ampK: 0.105, beat: 0.88 },
  // The whole body is the wave: bending from the head, slow and sinuous, more than a full
  // wavelength along it at once.
  anguilliform:  { u0: 0.04, exp: 1.15, k: 7.6, ampK: 0.135, beat: 0.7 },
};

/** Species whose mode does not follow from their `kind`. */
const MODE_BY_KEY: Readonly<Record<string, SwimMode>> = {
  // Billfish and wahoo are thunniform despite being plain `fish` in the table.
  marlin: 'thunniform', blackmarlin: 'thunniform', sailfish: 'thunniform',
  swordfish: 'thunniform', wahoo: 'thunniform', kingfish: 'thunniform',
  cero: 'thunniform', spanishmack: 'thunniform',
  // Blackfin IS a tuna (Thunnus atlanticus) but is typed `fish` in the creature table, where
  // `kind` also drives the scale-pattern and shine uniforms — so it is corrected here rather
  // than by reclassifying the animal and changing how it is painted.
  blackfin: 'thunniform',
  // The lamnid sharks swim like tunas — the famous case of convergent evolution. Every other
  // shark falls through to the subcarangiform default below.
  mako: 'thunniform', greatwhite: 'thunniform',
  // Long-bodied ambush and eel-like shapes carry more of the wave. A tarpon is a big flexible
  // animal — the body-twisting jump is the whole signature — so it is not stiff-bodied either.
  barracuda: 'subcarangiform', tarpon: 'subcarangiform', ladyfish: 'subcarangiform',
  snook: 'subcarangiform', cubera: 'carangiform',
  sawfish: 'anguilliform', nurse: 'anguilliform',
  // Flatfish undulate the whole fin margin, nose to tail, and `flat` has already laid the body
  // over — so the lateral wave is drawn in the vertical plane, which is exactly how one moves
  // over sand. Nothing about them is stiff.
  flounder: 'anguilliform', sole: 'anguilliform', halibut: 'anguilliform',
  // Deep-bodied reef fish are stiff forward and all tail behind.
  permit: 'carangiform', pompano: 'carangiform', lookdown: 'carangiform',
  palometa: 'carangiform', angelfish: 'carangiform', graytrigger: 'carangiform',
  mola: 'carangiform',
};

export function swimModeFor(key: string, V: CreatureVis): SwimMode {
  const named = MODE_BY_KEY[key];
  if (named) return named;
  if (V.kind === 'tuna') return 'thunniform';
  if (V.kind === 'shark') return 'subcarangiform';
  return 'carangiform';
}

/**
 * Tail-beat rate, rad/s.
 *
 * A small fish beats fast and a big one slow — a few centimetres of baitfish flickers at close
 * to ten hertz while a three-metre marlin cruises around half of one. The scaling is close to
 * `f ∝ L^-0.75` across that whole range, which is what this is, calibrated so a 0.4 m reef fish
 * sits near 3 Hz. Thunniform swimmers get a lift on top because that is how the mode works:
 * small amplitude traded for high frequency.
 *
 * The old constant 7.5 rad/s was 1.19 Hz for every animal in the ocean, which made the whole
 * school look like one toy.
 */
export function swimAngSpeed(key: string, V: CreatureVis): number {
  const hz = (BEAT_REF_HZ / Math.pow(Math.max(0.08, V.len), BEAT_LEN_EXP)) * MODES[swimModeFor(key, V)].beat;
  return Math.PI * 2 * clamp(hz, 0.18, 9);
}
const BEAT_REF_HZ = 1.51;   // gives ~3 Hz at 0.4 m
const BEAT_LEN_EXP = 0.75;

/** Wavenumber across the body, radians — how much of a wavelength is on the fish at once. */
export const swimWavenumber = (key: string, V: CreatureVis): number => MODES[swimModeFor(key, V)].k;

/** Peak lateral displacement (geometry units, before instance scale) of the swim wave at body
 * fraction `u` (0 nose .. 1 tail) — the closed form `computeSwimProfile` bakes per vertex for
 * lateral swimmers (`wig[i]`), exported so the spear hitbox (hitbox.ts) follows the same wave the
 * VAT draws instead of re-deriving it. test/fish-hitbox.test.ts pins the two together. */
export function lateralSwimAmp(key: string, V: CreatureVis, u: number): number {
  const m = MODES[swimModeFor(key, V)];
  const w = Math.pow(Math.max(0, u - m.u0) / (1 - m.u0), m.exp);
  return w * V.len * m.ampK;
}

/** The cycle angle the vertex shader feeds the VAT lookup (materials.ts `swTheta`) — sin() is
 * periodic, so no wrap is needed to evaluate it on the CPU. */
export const swimPhaseAt = (swimT: number, angSpeed: number, instancePhase: number): number => swimT * angSpeed + instancePhase;

/** legacy `addSwimAttrs` (index.html:2425-2438), split from its target (a live GPU attribute) —
 * see this module's header. */
export function computeSwimProfile(geo: THREE.BufferGeometry, key: string, V: CreatureVis): SwimProfile {
  const p = geo.attributes.position, n = p.count, L = V.len;
  const lat = V.kind === 'fish' || V.kind === 'tuna' || V.kind === 'shark';
  const vert = V.kind === 'dolphin' || V.kind === 'manatee' || V.kind === 'whale';
  const kWave = swimWavenumber(key, V);

  const wig = new Float32Array(n), wy = new Float32Array(n), wph = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const z = p.getZ(i), x = p.getX(i);
    const u = clamp(z / L + 0.5, 0, 1.25);
    // Calls the exported closed form rather than repeating it: the spear hitbox reads the same
    // function, and the two silently drifting apart is exactly the bug that pairing them avoids.
    if (lat) wig[i] = lateralSwimAmp(key, V, u);
    // Cetaceans oscillate the fluke with a stiff body — thunniform in the vertical plane — so
    // they take the same envelope rather than the old flat square law.
    if (vert) wy[i] = Math.pow(Math.max(0, u - 0.55) / 0.45, 2.4) * L * 0.075;
    if (V.kind === 'ray') wy[i] = Math.pow(Math.min(1, Math.abs(x) / ((V.wing ?? 1) / 2)), 2) * (V.wing ?? 1) * 0.16;
    if (V.kind === 'turtle') wy[i] = Math.abs(x) > L * 0.32 ? 0.07 * L : 0;
    wph[i] = u * kWave;
  }

  const scaled = (V.kind === 'fish' || V.kind === 'tuna') && !SHAPE[key]?.shark;
  const uScl = scaled ? L : 0;
  const uShn = V.kind === 'tuna' ? 1.3 : scaled ? 1 : 0.45;

  if (lat) return { axis: 'x', angSpeed: swimAngSpeed(key, V), amp: wig, phase: wph, uScl, uShn };
  // vertical axis: legacy's shader multiplies the *entire* swp (time term AND phase) by .55
  // (`sin(swp*.55)`) — pre-multiplying angSpeed and phase by .55 here reproduces that exactly
  // while keeping the baked cycle a clean 0..2*PI range (see vat.ts).
  const phase55 = new Float32Array(n);
  for (let i = 0; i < n; i++) phase55[i] = wph[i] * 0.55;
  return { axis: 'y', angSpeed: swimAngSpeed(key, V) * 0.55, amp: wy, phase: phase55, uScl, uShn };
}
