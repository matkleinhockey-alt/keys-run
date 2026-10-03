/**
 * God rays — docs/ARCHITECTURE.md "The underwater world" → "Rendering": "screen-space volumetric
 * from the sun, gated to High+ quality tier." Built on `postprocessing` v6's own `GodRaysEffect`
 * (the project already depends on `postprocessing`) rather than a hand-rolled radial-blur effect.
 *
 * `GodRaysEffect` needs a dedicated light-source mesh that "must not write depth and has to be
 * flagged as transparent" (its own docs). core/scene.ts's `sunDisc` is a plain opaque
 * `MeshBasicMaterial` used for the topside bloom core — mutating its material to satisfy that
 * requirement would risk visibly changing that unrelated look, and scene.ts isn't this agent's
 * file to begin with. This module creates its own throwaway disc instead and mirrors
 * `sceneCtx.sunDisc`'s transform onto it every frame (see index.ts's update loop) so visually it
 * tracks the real sun exactly, while staying fully independent.
 */
import * as THREE from 'three';
import { GodRaysEffect, BlendFunction, KernelSize } from 'postprocessing';

export interface GodRaysRig {
  effect: GodRaysEffect;
  lightMesh: THREE.Mesh;
  dispose(): void;
}

export function createGodRays(camera: THREE.Camera): GodRaysRig {
  const lightMesh = new THREE.Mesh(
    new THREE.CircleGeometry(150, 24),
    new THREE.MeshBasicMaterial({ color: 0xfff6dd, transparent: true, depthWrite: false, fog: false, toneMapped: false, opacity: 0.9 }),
  );
  lightMesh.renderOrder = -1; // behind everything that matters; GodRaysEffect samples it, not the eye
  lightMesh.frustumCulled = false;

  const effect = new GodRaysEffect(camera, lightMesh, {
    blendFunction: BlendFunction.SCREEN,
    samples: 40,
    density: 0.92,
    decay: 0.92,
    weight: 0.55,
    exposure: 0.5,
    clampMax: 1.0,
    resolutionScale: 0.5,
    kernelSize: KernelSize.SMALL,
    blur: true,
  });

  return {
    effect,
    lightMesh,
    dispose() {
      effect.dispose();
      lightMesh.geometry.dispose();
      (lightMesh.material as THREE.Material).dispose();
    },
  };
}
