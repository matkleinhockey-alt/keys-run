/**
 * `renderSchool(state, pool, view)` — the three.js half of the school.ts/render.ts split described
 * in docs/ARCHITECTURE.md's fish-ownership note. Reads the plain `wx/wy/wz/yaw/pitch/roll/
 * worldScale` numbers `stepSchool` wrote onto each member and submits them to the right LOD
 * bucket of the species' pool.
 *
 * This is where the Level-of-Detail decision actually happens, per fish, per frame:
 *
 *  - **Distance cull.** A fish whose apparent size is below `CULL_APPARENT` (pool.ts) is skipped.
 *  - **Frustum cull, per instance.** `InstancedMesh.frustumCulled` is useless here — three tests
 *    one bounding volume covering every instance, and a school's spread plus the camera sitting
 *    inside it means that volume is effectively the visible world, so it never rejects anything.
 *    Testing each fish's own small sphere against the camera frustum on the CPU is both cheaper
 *    and actually selective: looking away from a reef now costs nothing instead of costing every
 *    fish behind you.
 *  - **LOD bucket** by apparent size, so a 15 m whale keeps full detail at 300 m while a 40 cm
 *    snapper drops to the coarse body a few metres out (pool.ts's `lodFor`).
 *
 * The caller drives the frame: `beginPoolFrame` on every pool, then `renderSchool` for each
 * active school, then `endPoolFrame`. See entities/fish/index.ts.
 */
import * as THREE from 'three';
import type { SchoolState } from './types.js';
import { type SpeciesPool, lodFor, pushInstance } from './pool.js';

/** Everything the LOD decision needs about the viewer, recomputed once per frame by the caller. */
export interface RenderView {
  camX: number;
  camY: number;
  camZ: number;
  frustum: THREE.Frustum;
}

const _sphere = new THREE.Sphere();
const _center = new THREE.Vector3();

/** Per-frame counters, read by index.ts for the stats/profiler HUD. Reset by `beginRenderStats`. */
export const renderStats = {
  submitted: 0, culledDistance: 0, culledFrustum: 0,
  byTier: { impostor: 0, coarse: 0, low: 0, high: 0 } as Record<string, number>,
};

export function beginRenderStats(): void {
  renderStats.submitted = 0;
  renderStats.culledDistance = 0;
  renderStats.culledFrustum = 0;
  renderStats.byTier.impostor = renderStats.byTier.coarse = renderStats.byTier.low = renderStats.byTier.high = 0;
}

export function renderSchool(state: SchoolState, pool: SpeciesPool, view: RenderView): void {
  const baseLen = pool.V.len;
  const live = state.shown ?? state.members.length;
  // One fish may be part-way out of (or back into) the water — fish/thin.ts. It is the member at
  // the boundary of the eased float, and it draws scaled by the fraction so it shrinks away
  // instead of vanishing between two frames.
  const anim = state.shownAnim;
  const fadeIdx = anim !== undefined && anim < live ? Math.floor(anim) : -1;
  const fadeK = fadeIdx >= 0 ? anim! - fadeIdx : 1;
  for (let i = 0; i < live; i++) {
    const m = state.members[i];
    // below this it is a speck not worth a draw call, and a zero scale is a degenerate matrix
    const fade = i === fadeIdx ? fadeK : 1;
    if (fade < 0.02) continue;
    const dx = m.wx - view.camX, dy = m.wy - view.camY, dz = m.wz - view.camZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const worldLen = baseLen * m.worldScale * fade;

    const lod = lodFor(worldLen, dist);
    if (lod === null) { renderStats.culledDistance++; continue; }

    // Bounding sphere generous enough to cover fins and the swim-cycle displacement (which the
    // VAT applies in the vertex shader and so is invisible to any CPU-side bound) — a fish that
    // pops at the screen edge is far worse than one that is conservatively kept.
    _sphere.center = _center.set(m.wx, m.wy, m.wz);
    _sphere.radius = worldLen * 0.75;
    if (!view.frustum.intersectsSphere(_sphere)) { renderStats.culledFrustum++; continue; }

    if (pushInstance(pool, lod, m.wx, m.wy, m.wz, m.yaw, m.pitch, m.roll, m.worldScale * fade, m.swimPhase)) {
      renderStats.submitted++;
      renderStats.byTier[lod]++;
    }
  }
}
