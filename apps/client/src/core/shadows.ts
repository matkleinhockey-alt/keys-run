/**
 * Cascaded shadow maps (docs/ARCHITECTURE.md Part 2.5: "Move to cascaded shadow maps ... so
 * distant geometry actually casts"). Replaces the old single 1024² shadow map with a ±22 m ortho
 * frustum chasing the boat — that setup only ever let things within ~22 m of the boat cast a
 * shadow, so the bridge, docks and islands never did.
 *
 * Built on three's own `CSM` addon (three/addons/csm/CSM.js), which works by creating N
 * DirectionalLights — one per cascade — and globally swapping `THREE.ShaderChunk.lights_fragment_begin`
 * / `lights_pars_begin` for a cascade-aware version. That swapped chunk only activates per-material
 * when `material.defines.USE_CSM` is set (see CSMShader.js's `#if ... defined(USE_CSM)` guard), so
 * materials that never opt in keep rendering with plain single-shadow lighting — opting in is what
 * `setupMaterial`/`registerCSMMaterial` below do, and `applyToSubtree` sweeps a whole scene graph so
 * no hand-built material (hull, terrain, docks, bridge, vegetation, ...) is missed.
 *
 * Any material that already has its own `onBeforeCompile` — water (world/water.ts) and the wind-
 * animated palm fronds (world/islands.ts) are the two in this codebase — is one CSM must never
 * call `setupMaterial()` on directly, since that would overwrite its existing shader wholesale.
 * `registerCustomMaterial` instead always rebuilds `material.onBeforeCompile` fresh from the
 * *original* (CSM-agnostic) compile function the caller hands in, splicing in just the few CSM
 * uniform lines `setupMaterial` would have added. Two things make this load-bearing, found the
 * hard way while wiring up runtime quality-tier switching:
 *
 * 1. It must always re-wrap from that original function, never from "whatever onBeforeCompile is
 *    right now" — `CSM.dispose()` (real `setupMaterial`-registered materials only) reverts
 *    `material.onBeforeCompile` to a no-op, and quality changes dispose+recreate the CSM instance
 *    every time the tier changes. Wrapping from "current" would either nest a new closure around a
 *    stale one on every switch, or — after a dispose — permanently lose the custom shader entirely.
 * 2. The material must never be added to `csm.shaders` (the map `setupMaterial` uses to keep a
 *    material's CSM uniforms refreshed every frame) — `CSM.dispose()` iterates that map and does
 *    `delete shader.uniforms.CSM_cascades` etc. on whatever live shader object is registered there,
 *    which for a `setupMaterial`-registered material is fine (its onBeforeCompile is also being
 *    deleted in the same pass) but here would corrupt the one onBeforeCompile we need to keep.
 *    The small staleness cost (the 3 CSM uniforms only refresh on an actual recompile, not on every
 *    `updateFrustums()`) is immaterial — they only meaningfully change on a quality-tier switch,
 *    which already forces `material.needsUpdate = true` here.
 */
import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import type { QualitySettings } from './quality.js';

type OnBeforeCompile = THREE.MeshStandardMaterial['onBeforeCompile'];

export interface CascadedShadows {
  csm: CSM | null;
  /** Call every frame (after sunDir may have changed) to reposition the cascades. */
  update(sunDir: THREE.Vector3): void;
  /** Call on resize or quality change — recomputes frustum splits/shadow bounds. */
  updateFrustums(): void;
  /** Push the visible sun's current color/intensity onto every cascade light. */
  setLight(color: THREE.Color, intensity: number): void;
  /** Register any MeshStandardMaterial/MeshPhysicalMaterial found under `root` that hasn't been
   * seen before *by this CSM instance*. Safe to call repeatedly (e.g. each time a boat model is
   * swapped, or after a quality change creates a fresh CascadedShadows). */
  applyToSubtree(root: THREE.Object3D): void;
  /** For a material with its own existing onBeforeCompile (water, palm fronds) — the special
   * non-clobbering registration path; see module header. `baseCompile` is that material's own,
   * CSM-agnostic onBeforeCompile — always re-wrapped from this, never from the material's current
   * (possibly already CSM-wrapped) one. */
  registerCustomMaterial(material: THREE.MeshStandardMaterial, baseCompile: OnBeforeCompile): void;
  dispose(): void;
}

function wrapCustomCompile(csm: CSM, material: THREE.MeshStandardMaterial, baseCompile: OnBeforeCompile): void {
  material.defines = material.defines || {};
  material.defines.USE_CSM = 1;
  material.defines.CSM_CASCADES = csm.cascades;
  if (csm.fade) material.defines.CSM_FADE = '';
  else delete material.defines.CSM_FADE;
  material.onBeforeCompile = (shader, renderer) => {
    baseCompile.call(material, shader, renderer);
    const far = Math.min(csm.camera.far, csm.maxFar);
    const breaks: THREE.Vector2[] = [];
    for (let i = 0; i < csm.cascades; i++) breaks.push(new THREE.Vector2(i === 0 ? 0 : csm.breaks[i - 1], csm.breaks[i]));
    shader.uniforms.CSM_cascades = { value: breaks };
    shader.uniforms.cameraNear = { value: csm.camera.near };
    shader.uniforms.shadowFar = { value: far };
    // Deliberately NOT csm.shaders.set(material, shader) — see module header, point 2.
  };
  material.needsUpdate = true;
}

function unwrapCustomCompile(material: THREE.MeshStandardMaterial, baseCompile: OnBeforeCompile): void {
  if (material.defines) {
    delete material.defines.USE_CSM;
    delete material.defines.CSM_CASCADES;
    delete material.defines.CSM_FADE;
  }
  material.onBeforeCompile = baseCompile;
  material.needsUpdate = true;
}

export function createCascadedShadows(
  camera: THREE.PerspectiveCamera,
  scene: THREE.Scene,
  sunDir: THREE.Vector3,
  settings: QualitySettings['shadows'],
): CascadedShadows {
  if (!settings.enabled || settings.cascades <= 0) {
    return {
      csm: null,
      update() { /* no shadows at this tier */ },
      updateFrustums() { /* no shadows at this tier */ },
      setLight() { /* no shadows at this tier */ },
      applyToSubtree() { /* nothing to register */ },
      registerCustomMaterial(material, baseCompile) { unwrapCustomCompile(material, baseCompile); },
      dispose() { /* nothing to dispose */ },
    };
  }

  const csm = new CSM({
    camera,
    parent: scene,
    cascades: settings.cascades,
    maxFar: settings.maxFar,
    mode: 'practical',
    shadowMapSize: settings.mapSize,
    shadowBias: -0.0015,
    lightDirection: sunDir.clone().negate(),
    lightIntensity: 1,
    lightNear: 1,
    lightFar: settings.maxFar + 60,
    lightMargin: 60,
  });
  csm.fade = true;

  // Scoped to this CSM instance (not module-level): a quality change disposes the old CSM, which
  // reverts every setupMaterial()-registered material back to a plain no-op onBeforeCompile, so
  // the *new* CascadedShadows must be able to re-register everything from scratch.
  const seen = new WeakSet<THREE.Material>();

  return {
    csm,
    // CSM's `lightDirection` is the direction light RAYS TRAVEL (position -> target, i.e. away
    // from the sun); our `sunDir` convention everywhere else (water.ts's uSunDir, the sky shader)
    // is "direction TO the sun" — so this needs the negation, or shadows fall the wrong way.
    update(dirToSun) {
      csm.lightDirection.copy(dirToSun).negate();
      csm.update();
    },
    updateFrustums() { csm.updateFrustums(); },
    setLight(color, intensity) {
      for (const l of csm.lights) { l.color.copy(color); l.intensity = intensity; }
    },
    applyToSubtree(root) {
      root.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh) && !(obj instanceof THREE.InstancedMesh)) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (!(m instanceof THREE.MeshStandardMaterial) && !(m instanceof THREE.MeshPhysicalMaterial)) continue;
          if (seen.has(m)) continue;
          seen.add(m);
          csm.setupMaterial(m);
          m.needsUpdate = true; // force an explicit recompile rather than relying on cache-key diffing
        }
      });
    },
    registerCustomMaterial(material, baseCompile) {
      seen.add(material); // keep the generic applyToSubtree sweep from also calling setupMaterial on it
      wrapCustomCompile(csm, material, baseCompile);
    },
    dispose() { csm.dispose(); csm.remove(); },
  };
}
