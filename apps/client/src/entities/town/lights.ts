/**
 * The town's real lights: four PointLights, all of them or none of them.
 *
 * Why so few, and why that way: three.js compiles the light count into every lit material's shader
 * (that is why `entities/life/party-boats.ts` culls its boats' lights by distance rather than just
 * dimming them). A street of thirty lamps as real lights would put thirty lights into every
 * material in the world — the sea, the sky dome, every fish — for as long as the town existed.
 * So the town's glow is emissive and additive (kit.ts: windows, neon, halos, pools of light on the
 * pavement, all driven by `lightMats`), and the only real lights are this pool, which exists purely
 * so that the person and the car standing next to a lamp are warmly lit.
 *
 * ## The constraints this pool is built around
 *   - The count is constant. The pool is `POOL` lights while "hot" and zero otherwise; it never
 *     goes 4 -> 3 -> 2, because each change is a world-wide shader recompile. Individual lights
 *     fade by intensity instead (an intensity of 0 costs a loop iteration, not a recompile).
 *   - "Hot" means the player is in or near the town AND something wants lighting (sunset, or you
 *     are standing in an unlit-by-sun interior). At sea, or by day in the street, the count is 0.
 *   - Hysteresis on both edges so wading across the boundary cannot flap the count (a recompile
 *     per flap would be a hitch per footstep).
 *   - The lights live under the town's `near` group, so when that is culled for distance the lights
 *     leave the render with it — no separate bookkeeping to forget.
 */
import * as THREE from 'three';
import type { LightSource } from './build.js';

export const POOL = 4;
/** Sources farther than this from the camera are not considered, metres. */
export const LIGHT_RANGE = 70;

export interface LightPool {
  /** `hot`: the camera is in range of the town at all. `night`: the sunset blend, 0..1. `insideLot`: the walk-in building the camera is in, if any. */
  update(camLocal: THREE.Vector3, sources: readonly LightSource[], night: number, hot: boolean, insideLot: string | null): void;
  readonly active: boolean;
  /** Intensities and chosen sources, for debug. */
  debug(): Array<{ visible: boolean; intensity: number; kind: string; x: number; z: number }>;
  dispose(): void;
}

export function createLightPool(parent: THREE.Object3D): LightPool {
  const lights: THREE.PointLight[] = [];
  const kinds: string[] = [];
  for (let i = 0; i < POOL; i++) {
    const l = new THREE.PointLight(0xffe2a8, 0, 24, 2);
    l.visible = false; l.castShadow = false;
    parent.add(l); lights.push(l); kinds.push('none');
  }
  let active = false;
  const chosen = new Set<LightSource>();

  return {
    get active() { return active; },
    update(cam, sources, night, hot, insideLot): void {
      // hysteresis: on at k > 0.25 (or inside), off below 0.12
      const wants = hot && (night > (active ? 0.12 : 0.25) || insideLot !== null);
      if (wants !== active) { active = wants; for (const l of lights) l.visible = active; }
      if (!active) return;
      // nearest sources first; interior lamps only count while you are in that room
      const scored: Array<{ s: LightSource; d: number }> = [];
      for (const s of sources) {
        if (s.kind === 'lamp' && s.lot && s.lot !== insideLot) continue;
        const d = Math.hypot(s.x - cam.x, s.z - cam.z);
        if (d < LIGHT_RANGE) scored.push({ s, d });
      }
      scored.sort((a, b) => a.d - b.d);
      chosen.clear();
      for (let i = 0; i < POOL; i++) {
        const l = lights[i], pick = scored[i];
        if (!pick) { l.intensity += (0 - l.intensity) * 0.2; kinds[i] = 'none'; continue; }
        const s = pick.s;
        chosen.add(s);
        l.position.set(s.x, s.y, s.z);
        l.color.setHex(s.color);
        const interior = !!s.lot && s.kind === 'lamp';
        // exterior glow follows the sunset; interior lamps are on whenever you are in the room
        const want = interior ? 16 : (s.kind === 'neon' ? 34 : 22) * Math.min(1, night * 1.4);
        l.distance = interior ? 14 : s.kind === 'neon' ? 20 : 16;
        l.intensity += (want - l.intensity) * 0.18;
        kinds[i] = s.kind;
      }
    },
    debug: () => lights.map((l, i) => ({ visible: l.visible, intensity: +l.intensity.toFixed(2), kind: kinds[i], x: +l.position.x.toFixed(1), z: +l.position.z.toFixed(1) })),
    dispose(): void { lights.forEach((l) => { parent.remove(l); l.dispose(); }); },
  };
}
