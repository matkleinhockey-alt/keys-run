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
 *  - hiding the sky dome / sun disc and swapping `scene.background` for the current depth's
 *    inscatter tint once fully submerged — see `applySkyUnderwaterState` below for why this is
 *    needed on top of fog-override.ts's per-material chunk.
 */
import * as THREE from 'three';
import { EffectPass, type Effect, type EffectComposer } from 'postprocessing';
import type { QualityTier } from '../../core/quality.js';
import { createSurfaceTransition, type SurfaceTransition } from './transition.js';
import { createMarineSnow, type MarineSnow } from './marine-snow.js';
import { CausticsEffect } from './caustics.js';
import { LensWettingEffect } from './lens-wetting.js';
import { createGodRays, type GodRaysRig } from './godrays.js';
import { MARINE_SNOW_FULL_DEPTH, INSCATTER_COLOR, AMBIENT_HALF_DEPTH } from './depth-bands.js';
import { depthAt } from '@keysrun/shared/world/depth';
import { floorY } from '../seafloor.js';

/** The QA/debug dive hook's seafloor estimate, built from the REAL (not aspirational)
 * `world/seafloor.ts` — read-only import, this agent does not own that file. `floorY` is still
 * the documented-hazard, vertically-*compressed* single-plane formula
 * (`d => -(0.25 + min(d,14) * 0.55)`, docs/ARCHITECTURE.md "Seafloor"): it flattens to y≈-7.95 for
 * any true depth past 14 m. An earlier version of this hook estimated the floor as `-depthAt(x,z)`
 * (the *true*, uncompressed bathymetry) — that is lower (more negative, i.e. "deeper") than the
 * actually-rendered compressed floor at every depth, so the debug camera ended up embedded *below*
 * the real terrain surface at every single capture, seeing nothing but raw fog colour. Reading the
 * real export instead fixes that for any depth the compressed mesh still tracks. */
const seafloorHeightAt = (x: number, z: number): number => floorY(depthAt(x, z));

export interface UnderwaterDeps {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** The real, visible sun disc (core/scene.ts) — god rays mirrors its transform onto its own
   * dedicated light-source mesh every frame rather than reusing/mutating this one; see godrays.ts. */
  sunDisc: THREE.Object3D;
  /** The sky dome (core/scene.ts's `makeSky`, a 6 km-radius `BackSide` sphere with `fog: false`).
   * Hidden once fully submerged — see `applySkyUnderwaterState` below. */
  sky: THREE.Object3D;
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
  const { scene, camera, renderer, sunDisc, sky } = deps;

  const transition: SurfaceTransition = createSurfaceTransition(camera);
  const marineSnow: MarineSnow = createMarineSnow(renderer.getPixelRatio());
  scene.add(marineSnow.points);

  let godRays: GodRaysRig | null = null;
  let lensWetting: LensWettingEffect | null = null;

  // --- Sky-dome hide + background swap once fully submerged. ---
  // Why this is needed on top of fog-override.ts's global `fog_fragment` override: that override
  // can only reach materials that opt into three's fog pipeline, and the sky dome + sun disc
  // (core/scene.ts) are deliberately `fog: false` (so topside haze doesn't dim the sky it fades
  // toward — correct up there). The sky dome is also a literal 6 km-radius sphere enclosing the
  // *entire* world, including all underwater space. water.ts's Snell's-window branch only replaces
  // the view when a ray actually crosses the water plane's mesh (looking up through the ~96 deg
  // cone); a horizontal or downward underwater look that doesn't cross that plane — which happens
  // constantly once nothing solid is close enough to block it, e.g. open water past the reef's draw
  // distance, or anywhere the seafloor/reef geometry hasn't loaded — sails straight past every piece
  // of fog-respecting geometry and hits the raw, full-brightness sky dome instead: the horizon is
  // never darker than `uHor` (a pale near-white blue), which is exactly the washed-out look this
  // produced before this fix (verified against this branch's own screenshots at 15 m/25 m). Once
  // `transition.underwaterAmount()` is effectively 1, hide the dome + sun disc and paint
  // `scene.background` with the same depth-correct inscatter tint fog-override.ts's underwater
  // branch asymptotes toward at long range — so a line of sight with nothing in it reads as "deep
  // hazy water", not "the open sky, somehow, from 15 m down". Restored the moment the camera
  // surfaces. Threshold is high (not 0.5) so the swap lands after the fog/FOV/lens-wetting tween is
  // already visually busy, instead of being its own separate pop.
  const SKY_HIDE_AMOUNT = 0.98;
  let skyHidden = false;
  const bgColor = new THREE.Color();
  const originalBackground = scene.background;
  function applySkyUnderwaterState(): void {
    const amount = transition.underwaterAmount();
    const hide = amount >= SKY_HIDE_AMOUNT;
    if (hide !== skyHidden) {
      skyHidden = hide;
      sky.visible = !hide;
      sunDisc.visible = !hide;
      scene.background = hide ? bgColor : originalBackground;
    }
    if (hide) {
      const cameraDepth = Math.max(0, -camera.position.y);
      const ambientK = Math.exp(-cameraDepth / AMBIENT_HALF_DEPTH);
      bgColor.setRGB(INSCATTER_COLOR.r * ambientK, INSCATTER_COLOR.g * ambientK, INSCATTER_COLOR.b * ambientK);
    }
  }

  // --- Temporary debug/QA hook: drive the camera underwater without a diver entity. ---
  // Integration point for the real diver camera (entities/diver/**, a different agent): once that
  // rig exists and writes camera.position/rotation itself every frame, this block becomes dead
  // code (debugState stays null) and can be deleted outright — it does nothing unless something
  // calls window.__uwDebug.set(...).
  interface DebugDiveState { depth: number; x: number; z: number; yaw: number; pitch: number }
  let debugState: DebugDiveState | null = null;

  // Anti-clip floor clamp, but only where the real (compressed) seafloor mesh is still a
  // reasonable stand-in for the requested depth. Past ~10 m the mesh has already flattened
  // toward its y≈-7.95 crush-bug ceiling (docs/ARCHITECTURE.md "Seafloor"), so clamping a
  // "15 m"/"25 m" debug dive up to that floor would silently relabel it as an ~8 m shot instead.
  // Trusting the requested depth there is the honest choice — it is open water with nothing
  // underneath yet (no clipping risk either, since there is nothing solid down there to clip
  // into) rather than a mislabelled shallow one.
  function debugCameraY(depth: number, x: number, z: number): number {
    const floorClearance = seafloorHeightAt(x, z) + 0.3;
    return depth <= 10 ? Math.max(-depth, floorClearance) : -depth;
  }

  if (typeof window !== 'undefined') {
    (window as unknown as { __uwDebug: unknown }).__uwDebug = {
      /** `opts.instant`: also snap the surface-crossing tween (fog blend/FOV/sky-hide) straight to
       * its converged state instead of leaving it to tween in over the next few real frames. Off by
       * default so the organic crossing (the 06-surface-crossing capture, and anyone driving this
       * by hand) still behaves like a real one. Playwright QA screenshots taken immediately after a
       * teleport want this on — see transition.ts's `snap()` doc comment for why a fixed
       * `page.waitForTimeout()` does not reliably let the tween converge on its own in this
       * project's sandboxed, software-rendered test environment. */
      set(depth: number, opts: Partial<Omit<DebugDiveState, 'depth'>> & { instant?: boolean } = {}): void {
        debugState = { depth, x: opts.x ?? 0, z: opts.z ?? 0, yaw: opts.yaw ?? 0, pitch: opts.pitch ?? 0 };
        if (opts.instant) {
          transition.snap(debugCameraY(debugState.depth, debugState.x, debugState.z) < 0);
          applySkyUnderwaterState();
        }
      },
      clear(): void { debugState = null; },
    };
  }

  function update(dt: number): void {
    if (debugState) {
      const y = debugCameraY(debugState.depth, debugState.x, debugState.z);
      camera.position.set(debugState.x, y, debugState.z);
      camera.near = 0.05;
      camera.rotation.set(debugState.pitch, debugState.yaw, 0, 'YXZ');
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
    }

    transition.update(dt);
    applySkyUnderwaterState();

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
      if (skyHidden) { sky.visible = true; sunDisc.visible = true; scene.background = originalBackground; }
      transition.dispose();
      if (typeof window !== 'undefined') delete (window as unknown as { __uwDebug?: unknown }).__uwDebug;
    },
  };
}
