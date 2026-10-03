/**
 * Quality tiers: the single source of truth for everything the performance budget in
 * docs/ARCHITECTURE.md ("60 fps on an M1 Air / GTX 1650 · < 400 draw calls topside · < 2.5 M
 * triangles") gates behind a knob — pixel ratio, water tessellation, shadow cascades/resolution,
 * draw distance (fog far) and which post-processing effects run.
 *
 * The default tier is auto-detected from a quick GPU probe (WEBGL_debug_renderer_info + core
 * count + touch) the first time the game boots, then remembered in localStorage. The player can
 * override it at any time (start screen + in-HUD button, both call `World.setQuality`).
 */
import { isTouch } from './scene.js';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';
export const QUALITY_TIERS: QualityTier[] = ['low', 'medium', 'high', 'ultra'];

export interface QualitySettings {
  tier: QualityTier;
  /** Hard cap on devicePixelRatio; the actual value used is still min(window.devicePixelRatio, cap). */
  pixelRatioCap: number;
  /** Water plane tessellation (segments per side — legacy/r128 default was 220 desktop / 150 touch). */
  waterSegments: number;
  shadows: {
    enabled: boolean;
    cascades: number;
    mapSize: number;
    /** How far from the camera cascaded shadows extend (metres). Shadows beyond this just stop;
     * at this draw distance that's imperceptible (docs/ARCHITECTURE.md's 1,900 m horizon is a haze/
     * sky concern, not a shadow one). */
    maxFar: number;
  };
  /** scene.fog far plane — also a cheap overdraw/fill-rate lever on integrated GPUs. */
  fogFar: number;
  /** Instance count for the cloud InstancedMesh (see world/clouds.ts). */
  cloudInstances: number;
  post: {
    bloom: boolean;
    ssao: boolean;
    antialias: 'none' | 'fxaa' | 'smaa';
  };
}

const TIERS: Record<QualityTier, QualitySettings> = {
  low: {
    tier: 'low',
    pixelRatioCap: 1,
    waterSegments: 64,
    shadows: { enabled: false, cascades: 0, mapSize: 0, maxFar: 0 },
    fogFar: 950,
    cloudInstances: 36,
    post: { bloom: false, ssao: false, antialias: 'fxaa' },
  },
  medium: {
    tier: 'medium',
    pixelRatioCap: 1.25,
    waterSegments: 120,
    // With only 1 cascade there's no frustum splitting — this single shadow map covers 0..maxFar
    // in one texture, so maxFar doubles as the resolution/coverage trade-off: a single-cascade CSM
    // with a huge maxFar sizes its ortho box to the whole visible frustum and a 9 m boat's shadow
    // falls to a handful of texels (invisible). Kept tight enough that the boat and nearby docks
    // read clearly; see this project's report for the measured before/after.
    shadows: { enabled: true, cascades: 1, mapSize: 1024, maxFar: 90 },
    fogFar: 1350,
    cloudInstances: 60,
    post: { bloom: true, ssao: false, antialias: 'fxaa' },
  },
  high: {
    // This is the tier tuned to the docs/ARCHITECTURE.md budget line (M1 Air / GTX 1650, <400 draw
    // calls topside): one shadow cascade, no SSAO (its NormalPass is a full extra scene draw-call
    // pass — cheap in theory, expensive here because the hand-built boat/dock/bridge geometry is
    // already hundreds of individual small meshes rather than merged batches; see this project's
    // report for the measured numbers and why SSAO/more cascades are Ultra-only instead).
    tier: 'high',
    pixelRatioCap: 1.75,
    waterSegments: 190,
    shadows: { enabled: true, cascades: 1, mapSize: 2048, maxFar: 110 },
    fogFar: 1750,
    cloudInstances: 90,
    post: { bloom: true, ssao: false, antialias: 'smaa' },
  },
  ultra: {
    // No draw-call budget guarantee — the "no compromises on a strong discrete GPU" tier. 2
    // cascades: 'practical' split mode auto-sizes cascade 0 much tighter than a single-cascade
    // tier can (it only has to cover the near slice), so this gets both a crisp boat/dock shadow
    // *and* distant coverage out to maxFar from cascade 1.
    tier: 'ultra',
    pixelRatioCap: 2,
    waterSegments: 260,
    shadows: { enabled: true, cascades: 2, mapSize: 2048, maxFar: 420 },
    fogFar: 1900,
    cloudInstances: 140,
    post: { bloom: true, ssao: true, antialias: 'smaa' },
  },
};

export function getQualitySettings(tier: QualityTier): QualitySettings {
  return TIERS[tier];
}

export interface GpuProbe {
  renderer: string;
  isSoftware: boolean;
  cores: number;
  touch: boolean;
}

export function probeGpu(gl: WebGL2RenderingContext | WebGLRenderingContext): GpuProbe {
  let rendererStr = 'unknown';
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    rendererStr = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch { /* some browsers block this probe entirely — fall back to the generic bucket below */ }
  return {
    renderer: rendererStr,
    isSoftware: /swiftshader|llvmpipe|software|basic render/i.test(rendererStr),
    cores: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4,
    touch: isTouch(),
  };
}

/** Bucket a GPU probe into a default tier. Conservative on anything we can't positively identify
 * as capable — a wrongly-low default only costs some fidelity; a wrongly-high one costs frame rate,
 * which is the one the budget actually forbids. */
export function detectDefaultTier(probe: GpuProbe): QualityTier {
  const s = probe.renderer.toLowerCase();
  if (probe.isSoftware) return 'low';
  const highEnd = /rtx|gtx\s?1[6-9]\d\d|gtx\s?2\d\d\d|rx\s?[5-9]\d\d\d|radeon pro|quadro|arc a7|apple m[2-9]/.test(s);
  const appleM1Class = /apple m1\b|apple gpu/.test(s);
  const integrated = /intel|iris|uhd graphics|mali|adreno|powervr/.test(s);
  if (highEnd && probe.cores >= 8) return 'ultra';
  if (highEnd || appleM1Class) return 'high'; // the M1 Air / GTX 1650 budget baseline
  if (probe.touch || integrated) return probe.cores <= 4 ? 'low' : 'medium';
  return probe.cores >= 6 ? 'high' : 'medium';
}

const STORAGE_KEY = 'keysrun.quality';

export function loadSavedTier(): QualityTier | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && QUALITY_TIERS.includes(v as QualityTier) ? (v as QualityTier) : null;
  } catch { return null; }
}

export function saveTier(tier: QualityTier): void {
  try { localStorage.setItem(STORAGE_KEY, tier); } catch { /* private browsing etc. — just don't persist */ }
}
