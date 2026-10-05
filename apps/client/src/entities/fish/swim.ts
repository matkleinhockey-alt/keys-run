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

const SWIM_ANG_BASE = 7.5;

/** legacy `addSwimAttrs` (index.html:2425-2438), split from its target (a live GPU attribute) —
 * see this module's header. */
export function computeSwimProfile(geo: THREE.BufferGeometry, key: string, V: CreatureVis): SwimProfile {
  const p = geo.attributes.position, n = p.count, L = V.len;
  const lat = V.kind === 'fish' || V.kind === 'tuna' || V.kind === 'shark';
  const vert = V.kind === 'dolphin' || V.kind === 'manatee' || V.kind === 'whale';
  const amp = V.kind === 'tuna' ? 0.05 : V.kind === 'shark' ? 0.08 : 0.1;

  const wig = new Float32Array(n), wy = new Float32Array(n), wph = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const z = p.getZ(i), x = p.getX(i);
    const u = clamp(z / L + 0.5, 0, 1.25);
    const w = Math.pow(Math.max(0, u - 0.28) / 0.72, 2);
    if (lat) wig[i] = w * L * amp;
    if (vert) wy[i] = w * L * 0.07;
    if (V.kind === 'ray') wy[i] = Math.pow(Math.min(1, Math.abs(x) / ((V.wing ?? 1) / 2)), 2) * (V.wing ?? 1) * 0.16;
    if (V.kind === 'turtle') wy[i] = Math.abs(x) > L * 0.32 ? 0.07 * L : 0;
    wph[i] = u * 2.6;
  }

  const scaled = (V.kind === 'fish' || V.kind === 'tuna') && !SHAPE[key]?.shark;
  const uScl = scaled ? L : 0;
  const uShn = V.kind === 'tuna' ? 1.3 : scaled ? 1 : 0.45;

  if (lat) return { axis: 'x', angSpeed: SWIM_ANG_BASE, amp: wig, phase: wph, uScl, uShn };
  // vertical axis: legacy's shader multiplies the *entire* swp (time term AND phase) by .55
  // (`sin(swp*.55)`) — pre-multiplying angSpeed and phase by .55 here reproduces that exactly
  // while keeping the baked cycle a clean 0..2*PI range (see vat.ts).
  const phase55 = new Float32Array(n);
  for (let i = 0; i < n; i++) phase55[i] = wph[i] * 0.55;
  return { axis: 'y', angSpeed: SWIM_ANG_BASE * 0.55, amp: wy, phase: phase55, uScl, uShn };
}
