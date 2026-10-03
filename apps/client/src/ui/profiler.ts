/**
 * Performance profiler HUD (docs/ARCHITECTURE.md "Performance budget (enforced, with a profiler
 * HUD)"): FPS, frame time, draw calls, triangles and the active quality tier. Toggled with P,
 * off by default so it never shows up in a normal screenshot.
 */
import * as THREE from 'three';
import type { QualityTier } from '../core/quality.js';

export interface Profiler {
  toggle(): void;
  visible(): boolean;
  /** Call once per frame, after renderer.render(). */
  sample(dt: number, renderer: THREE.WebGLRenderer, tier: QualityTier): void;
  /** Last-sampled numbers, for the automated screenshot/verification harness to read back. */
  readonly stats: { fps: number; frameMs: number; calls: number; triangles: number; tier: QualityTier };
}

export function createProfiler(): Profiler {
  const el = document.createElement('div');
  el.id = 'profilerHud';
  el.style.cssText = [
    'position:fixed', 'top:8px', 'left:8px', 'z-index:80',
    'background:rgba(8,14,20,.78)', 'color:#9ef7c9', 'font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace',
    'padding:8px 11px', 'border-radius:8px', 'pointer-events:none', 'white-space:pre',
    'box-shadow:0 2px 10px rgba(0,0,0,.35)', 'display:none',
  ].join(';');
  document.body.appendChild(el);

  let shown = false;
  let acc = 0, frames = 0, fps = 0, lastDomUpdate = 0;
  const stats = { fps: 0, frameMs: 0, calls: 0, triangles: 0, tier: 'high' as QualityTier };

  return {
    toggle() { shown = !shown; el.style.display = shown ? 'block' : 'none'; },
    visible() { return shown; },
    get stats() { return stats; },
    sample(dt, renderer, tier) {
      acc += dt; frames++;
      if (acc >= 0.5) { fps = frames / acc; acc = 0; frames = 0; }
      const info = renderer.info;
      stats.fps = fps;
      stats.frameMs = dt * 1000;
      stats.calls = info.render.calls;
      stats.triangles = info.render.triangles;
      stats.tier = tier;
      if (!shown) return;
      const now = performance.now();
      if (now - lastDomUpdate < 200) return;
      lastDomUpdate = now;
      el.textContent =
        `fps        ${fps.toFixed(0).padStart(4)}\n` +
        `frame      ${(dt * 1000).toFixed(1).padStart(4)} ms\n` +
        `draw calls ${String(info.render.calls).padStart(4)}\n` +
        `triangles  ${(info.render.triangles / 1000).toFixed(0).padStart(4)}k\n` +
        `geoms/tex  ${info.memory.geometries}/${info.memory.textures}\n` +
        `quality    ${tier}`;
    },
  };
}
