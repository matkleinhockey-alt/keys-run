/**
 * The surface crossing — docs/ARCHITECTURE.md: "The ~200 ms crossing y=0 is the most important
 * moment in the game: fog blended over ~0.3 s, FOV narrowing to ~0.75x (dive-mask), a lens-wetting
 * screen effect, and a hook for audio lowpass."
 *
 * The fog blend itself lives in fog-override.ts (purely a function of `cameraPosition.y`, no
 * state needed there). This module owns the *other* three: it tweens `camera.fov`, drives
 * lens-wetting.ts's transient wetness pulse, and fires a callback + a `window` CustomEvent on each
 * crossing for whichever system ends up owning audio to hook a lowpass crossfade onto — this
 * module does not touch audio itself, per the brief ("expose an event/callback, don't implement
 * audio").
 *
 * No diver entity exists yet (a different agent owns entities/diver/**), so today the only way
 * the camera goes underwater at all is the debug hook in world/underwater/index.ts. This module
 * doesn't know or care how the camera got below y=0 — it just watches `camera.position.y`, so
 * whatever the diver agent's real camera rig turns out to be, this keeps working unmodified.
 */
import * as THREE from 'three';
import { SURFACE_BAND } from './depth-bands.js';

export const UNDERWATER_FOV_SCALE = 0.75;
/** Time constant (not a hard duration) for the FOV/fog-adjacent tween — see this file's header;
 * matches fog-override.ts's SURFACE_BAND-driven blend closely enough that the two reinforce
 * rather than visibly disagree about when "the crossing" is happening. */
const TWEEN_TAU = 0.12;
const WETNESS_DECAY_TAU = 0.45;

export interface SurfaceTransition {
  /** Call every frame, after the camera's final position for this frame is set. */
  update(dt: number): void;
  isUnderwater(): boolean;
  /** 0 (fully surface) .. 1 (fully submerged) — same shape of curve fog-override.ts's GLSL uses,
   * computed independently here since JS and a globally-shared GLSL chunk can't share state. */
  underwaterAmount(): number;
  /** Transient lens-wetting pulse, ~1 right at a crossing, decaying over ~1s. */
  wetness(): number;
  /** Fires on every crossing; returns an unsubscribe function. */
  onCross(cb: (goingUnder: boolean) => void): () => void;
  dispose(): void;
}

export function createSurfaceTransition(camera: THREE.PerspectiveCamera): SurfaceTransition {
  const baseFov = camera.fov;
  let wasUnderwater = camera.position.y < 0;
  let amount = wasUnderwater ? 1 : 0;
  let wet = 0;
  const listeners = new Set<(goingUnder: boolean) => void>();

  return {
    update(dt) {
      // Small hysteresis (SURFACE_BAND, the same half-width fog-override.ts's shader blend uses)
      // around y=0 so floating-point jitter sitting almost exactly on the surface can't flip this
      // back and forth and spam cross events.
      const y = camera.position.y;
      const underwater = wasUnderwater ? y <= SURFACE_BAND : y < -SURFACE_BAND;
      if (underwater !== wasUnderwater) {
        wasUnderwater = underwater;
        wet = 1;
        for (const cb of listeners) cb(underwater);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('keysrun:surface-cross', { detail: { underwater } }));
        }
      }
      const target = underwater ? 1 : 0;
      const k = 1 - Math.exp(-dt / TWEEN_TAU);
      amount += (target - amount) * k;
      if (amount < 1e-4) amount = 0;
      else if (amount > 1 - 1e-4) amount = 1;

      wet *= Math.exp(-dt / WETNESS_DECAY_TAU);
      if (wet < 1e-3) wet = 0;

      const fov = baseFov * (1 - (1 - UNDERWATER_FOV_SCALE) * amount);
      if (Math.abs(camera.fov - fov) > 1e-4) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
    },
    isUnderwater() { return wasUnderwater; },
    underwaterAmount() { return amount; },
    wetness() { return wet; },
    onCross(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    dispose() {
      listeners.clear();
      if (Math.abs(camera.fov - baseFov) > 1e-4) {
        camera.fov = baseFov;
        camera.updateProjectionMatrix();
      }
    },
  };
}

/** Local stand-in for SURFACE_BAND's use in the shader-side blend — exported so index.ts / tests
 * can sanity-check the two models agree on where "the surface" is without importing GLSL. */
export { SURFACE_BAND };
