/**
 * Procedural tileable textures: water ripples, foam breakup, and sand/grass/deck grain.
 *
 * Ported faithfully from legacy/index.html:461-480. `makeNoiseField` is pure value noise (plain
 * math, kept as-is); `dataTex`/`waterNoiseTex`/`grainTex` wrap it in three.js `DataTexture`s,
 * which is why this lives in apps/client rather than packages/shared.
 */
import * as THREE from 'three';
import { clamp } from './math.js';

function makeNoiseField(N: number, seedv: number): Float32Array {
  let sd = seedv;
  const r = (): number => (sd = (sd * 16807) % 2147483647) / 2147483647;
  const out = new Float32Array(N * N);
  const octaves: Array<[number, number]> = [[4, 0.5], [8, 0.28], [16, 0.14], [32, 0.07], [64, 0.035]];
  octaves.forEach(([L, amp]) => {
    const g = new Float32Array(L * L);
    for (let i = 0; i < L * L; i++) g[i] = r();
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const fx = (x / N) * L, fy = (y / N) * L, x0 = fx | 0, y0 = fy | 0, u = fx - x0, v = fy - y0;
        const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
        const a = g[(y0 % L) * L + x0 % L], b = g[(y0 % L) * L + (x0 + 1) % L];
        const c = g[((y0 + 1) % L) * L + x0 % L], d = g[((y0 + 1) % L) * L + (x0 + 1) % L];
        out[y * N + x] += amp * ((a * (1 - su) + b * su) * (1 - sv) + (c * (1 - su) + d * su) * sv);
      }
    }
  });
  return out;
}

function dataTex(data: Uint8Array, N: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

const NOISE_N = 256;
const NF1 = makeNoiseField(NOISE_N, 7);
const NF2 = makeNoiseField(NOISE_N, 91);

function buildWaterNoiseTex(): THREE.DataTexture {
  const N = NOISE_N, d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const hx = NF1[y * N + (x + 1) % N] - NF1[y * N + (x + N - 1) % N];
      const hz = NF1[((y + 1) % N) * N + x] - NF1[((y + N - 1) % N) * N + x];
      d[i * 4] = clamp(128 + hx * 900, 0, 255);
      d[i * 4 + 1] = clamp(128 + hz * 900, 0, 255);
      d[i * 4 + 2] = clamp(NF1[i] * 255, 0, 255);
      d[i * 4 + 3] = clamp(NF2[i] * 255, 0, 255);
    }
  }
  return dataTex(d, N);
}

/** Lazily built, module-singleton (legacy built it once at top level too). */
let _waterNoiseTex: THREE.DataTexture | null = null;
export function waterNoiseTex(): THREE.DataTexture {
  if (!_waterNoiseTex) _waterNoiseTex = buildWaterNoiseTex();
  return _waterNoiseTex;
}

/** legacy `grainTex(rep,lo,hi)` — a repeated, shaded luminance grain texture. */
export function grainTex(rep: [number, number], lo: number, hi: number): THREE.DataTexture {
  const N = NOISE_N, d = new Uint8Array(N * N * 4);
  for (let i = 0; i < N * N; i++) {
    const v = clamp((lo + (hi - lo) * (NF2[i] * 0.7 + NF1[i] * 0.6 - 0.15)) * 255, 0, 255);
    d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v * 0.97; d[i * 4 + 3] = 255;
  }
  const t = dataTex(d, N);
  t.repeat.set(rep[0], rep[1]);
  return t;
}
