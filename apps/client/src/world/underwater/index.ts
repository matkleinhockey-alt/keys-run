/**
 * Underwater world orchestrator — ties together everything in this directory plus water.ts's
 * Snell's-window branch and fog-override.ts's global extinction into one thing game/world.ts
 * calls into. See docs/ARCHITECTURE.md "The underwater world" → "Rendering" for the brief.
 *
 * Owns:
 *  - the surface-crossing transition (FOV narrowing, lens-wetting pulse, the audio-lowpass hook)
 *  - marine snow (a scene object, persists across quality-tier changes)
 *  - caustics + lens-wetting + (High+ only) god rays, as an *additional* `EffectPass` appended to
 *    postfx.ts's existing composer — `attachPostFX` must be called again every time game/world.ts
 *    recreates that composer (quality tier change), since `EffectComposer.dispose()` tears down
 *    every pass it holds, ours included.
 *  - a temporary debug hook (`window.__uwDebug`) to put the camera underwater for screenshots/QA.
 *    No diver entity exists yet (a different agent owns entities/diver/**) — see this hook's own
 *    comment for the real integration point once it lands.
 */
import * as THREE from 'three';
import { EffectPass, type Effect, type EffectComposer } from 'postprocessing';
import type { QualityTier } from '../../core/quality.js';
import { createSurfaceTransition, type SurfaceTransition } from './transition.js';
import { createMarineSnow, type MarineSnow } from './marine-snow.js';
import { CausticsEffect } from './caustics.js';
import { LensWettingEffect } from './lens-wetting.js';
import { createGodRays, type GodRaysRig } from './godrays.js';
import { MARINE_SNOW_FULL_DEPTH } from './depth-bands.js';
import { depthAt } from '@keysrun/shared/world/depth';

/** Stand-in for the seafloor agent's `seafloorHeightAt(x,z)` (concurrently landing in
 * world/seafloor.ts — a client file this agent must not edit — as part of fixing the
 * `floorY = d => -(0.25 + min(d,14)*0.55)` crush bug documented in docs/ARCHITECTURE.md's
 * "Seafloor" section). That fix's target shape is simply `d => -d`, and `depthAt` (the pure,
 * shared bathymetry function the fix itself is built on, @keysrun/shared/world/depth) already
 * exists and is stable today — so `-depthAt(x,z)` is not a guess, it is exactly what
 * `seafloorHeightAt` will return once that lands. The only call site is the debug-dive depth
 * clamp below (so the QA camera never ends up below the actual terrain); swap to a direct import
 * of the real `seafloorHeightAt` once it exists, for the LOD-chunk-aware version. */
const fallbackSeafloorHeightAt = (x: number, z: number): number => -depthAt(x, z);

export interface UnderwaterDeps {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** The real, visible sun disc (core/scene.ts) — god rays mirrors its transform onto its own
   * dedicated light-source mesh every frame rather than reusing/mutating this one; see godrays.ts. */
  sunDisc: THREE.Object3D;
}

export interface UnderwaterWorld {
  /** Call once per frame, after updateCamera() has set the camera's final transform and before
   * postfx.render(). */
  update(dt: number): void;
  /** Call once at boot (after the first createPostFX) and again every time game/world.ts
   * recreates the postfx composer (quality tier change) — see this file's header. */
  attachPostFX(composer: EffectComposer, tier: QualityTier): void;
  isUnderwater(): boolean;
  /** Subscribe to surface crossings (also dispatched as a `keysrun:surface-cross` window
   * CustomEvent, detail `{underwater: boolean}`) — for the audio agent's lowpass crossfade. This
   * module does not touch audio itself. Returns an unsubscribe function. */
  onSurfaceCross(cb: (goingUnder: boolean) => void): () => void;
  dispose(): void;
}

export function createUnderwaterWorld(deps: UnderwaterDeps): UnderwaterWorld {
  const { scene, camera, renderer, sunDisc } = deps;

  const transition: SurfaceTransition = createSurfaceTransition(camera);
  const marineSnow: MarineSnow = createMarineSnow(renderer.getPixelRatio());
  scene.add(marineSnow.points);

  let godRays: GodRaysRig | null = null;
  let lensWetting: LensWettingEffect | null = null;

  // --- Temporary debug/QA hook: drive the camera underwater without a diver entity. ---
  // Integration point for the real diver camera (entities/diver/**, a different agent): once that
  // rig exists and writes camera.position/rotation itself every frame, this block becomes dead
  // code (debugState stays null) and can be deleted outright — it does nothing unless something
  // calls window.__uwDebug.set(...).
  interface DebugDiveState { depth: number; x: number; z: number; yaw: number; pitch: number }
  let debugState: DebugDiveState | null = null;
  if (typeof window !== 'undefined') {
    (window as unknown as { __uwDebug: unknown }).__uwDebug = {
      set(depth: number, opts: Partial<Omit<DebugDiveState, 'depth'>> = {}): void {
        debugState = { depth, x: opts.x ?? 0, z: opts.z ?? 0, yaw: opts.yaw ?? 0, pitch: opts.pitch ?? 0 };
      },
      clear(): void { debugState = null; },
    };
  }

  function update(dt: number): void {
    if (debugState) {
      const floorY = fallbackSeafloorHeightAt(debugState.x, debugState.z);
      const y = Math.max(-debugState.depth, floorY + 0.3);
      camera.position.set(debugState.x, y, debugState.z);
      camera.near = 0.05;
      camera.rotation.set(debugState.pitch, debugState.yaw, 0, 'YXZ');
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
    }

    transition.update(dt);

    if (godRays) {
      godRays.lightMesh.position.copy(sunDisc.position);
      godRays.lightMesh.quaternion.copy(sunDisc.quaternion);
    }
    lensWetting?.setAmounts(transition.wetness(), transition.underwaterAmount());

    const cameraDepth = Math.max(0, -camera.position.y);
    const snowFraction = Math.min(1, cameraDepth / MARINE_SNOW_FULL_DEPTH) * transition.underwaterAmount();
    marineSnow.update(dt, camera.position, snowFraction);
  }

  function attachPostFX(composer: EffectComposer, tier: QualityTier): void {
    // The composer this used to be attached to (if any) is already gone by the time this runs —
    // game/world.ts always calls postfx.dispose() (which disposes every pass, ours included)
    // before createPostFX() builds the replacement — so there is nothing of ours left to remove;
    // just dispose our own non-composer-owned resource (the god-rays light mesh) and rebuild.
    if (godRays) { scene.remove(godRays.lightMesh); godRays.dispose(); godRays = null; }

    const caustics = new CausticsEffect();
    const wetting = new LensWettingEffect();
    lensWetting = wetting;

    const effects: Effect[] = [caustics, wetting];
    if (tier === 'high' || tier === 'ultra') {
      godRays = createGodRays(camera);
      scene.add(godRays.lightMesh);
      effects.push(godRays.effect);
    }
    composer.addPass(new EffectPass(camera, ...effects));
  }

  return {
    update,
    attachPostFX,
    isUnderwater() { return transition.isUnderwater(); },
    onSurfaceCross(cb) { return transition.onCross(cb); },
    dispose() {
      scene.remove(marineSnow.points);
      marineSnow.dispose();
      if (godRays) { scene.remove(godRays.lightMesh); godRays.dispose(); godRays = null; }
      transition.dispose();
      if (typeof window !== 'undefined') delete (window as unknown as { __uwDebug?: unknown }).__uwDebug;
    },
  };
}
