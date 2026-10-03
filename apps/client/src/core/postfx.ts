/**
 * Post-processing stack (docs/ARCHITECTURE.md Part 2 item 2): bloom on the sun/specular
 * highlights, SSAO for contact shadows under hulls/docks/terrain, FXAA/SMAA, tone mapping and a
 * subtle filmic grade — all gated behind the active quality tier (core/quality.ts).
 *
 * Built on the `postprocessing` package rather than three's own examples/jsm EffectComposer:
 * it merges every effect that doesn't need its own extra input (bloom, SSAO, tone mapping, the
 * colour grade, FXAA/SMAA) into a single combined shader pass instead of one full-screen draw per
 * effect, which matters for the < 400 draw call budget.
 *
 * Tone mapping moves here deliberately: `postprocessing`'s EffectComposer draws its final output
 * with its own full-screen shader, which does NOT go through three's `renderer.toneMapping` (that
 * only applies inside three's own material shaders). So once the composer is active it — not
 * `renderer.toneMapping` — owns ACES tone mapping; `createPostFX` sets `renderer.toneMapping =
 * NoToneMapping` to make that explicit and avoid ever double-applying it.
 */
import * as THREE from 'three';
import {
  BloomEffect, BrightnessContrastEffect, EffectComposer, EffectPass, FXAAEffect,
  HueSaturationEffect, NormalPass, RenderPass, SMAAEffect, SMAAPreset, SSAOEffect,
  ToneMappingEffect, ToneMappingMode, BlendFunction,
} from 'postprocessing';
import type { QualitySettings } from './quality.js';

export interface PostFX {
  composer: EffectComposer;
  render(dt: number): void;
  setSize(w: number, h: number): void;
  dispose(): void;
}

export function createPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  settings: QualitySettings['post'],
): PostFX {
  renderer.toneMapping = THREE.NoToneMapping; // the composer's ToneMappingEffect owns this now

  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
  composer.addPass(new RenderPass(scene, camera));

  const disposables: Array<{ dispose(): void }> = [];
  const effects = [];

  if (settings.ssao) {
    const normalPass = new NormalPass(scene, camera);
    composer.addPass(normalPass);
    disposables.push(normalPass);
    const ssao = new SSAOEffect(camera, normalPass.texture, {
      blendFunction: BlendFunction.MULTIPLY,
      samples: 11, rings: 7,
      luminanceInfluence: 0.6,
      radius: 0.12, intensity: 1.4, bias: 0.03, fade: 0.015,
      resolutionScale: 0.75,
      worldDistanceThreshold: 80, worldDistanceFalloff: 20,
      worldProximityThreshold: 6, worldProximityFalloff: 2,
    });
    effects.push(ssao);
  }

  if (settings.bloom) {
    effects.push(new BloomEffect({
      blendFunction: BlendFunction.SCREEN,
      mipmapBlur: true, intensity: 1.15, radius: 0.82, levels: 7,
      luminanceThreshold: 0.85, luminanceSmoothing: 0.2,
    }));
  }

  // ACES tone mapping + a subtle filmic grade (Part 2 item 1) — a small saturation/contrast lift
  // that reads as "graded" rather than raw HDR tonemap output.
  effects.push(new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }));
  effects.push(new HueSaturationEffect({ saturation: 0.06 }));
  effects.push(new BrightnessContrastEffect({ brightness: 0.0, contrast: 0.05 }));

  if (settings.antialias === 'smaa') {
    effects.push(new SMAAEffect({ preset: SMAAPreset.HIGH }));
  } else if (settings.antialias === 'fxaa') {
    effects.push(new FXAAEffect());
  }

  const effectPass = new EffectPass(camera, ...effects);
  composer.addPass(effectPass);

  return {
    composer,
    render(dt) { composer.render(dt); },
    setSize(w, h) { composer.setSize(w, h); },
    dispose() {
      composer.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
