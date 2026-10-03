/**
 * Procedural-only textures for the reef (requirement 4: "no downloaded assets... build
 * convincing coral procedurally now"). These are runtime-generated `THREE.DataTexture`s, the same
 * technique core/textures.ts already uses for sand/grass grain and bump — not image files, so
 * they don't count against "the project ships ZERO image textures". Kept local to this directory
 * (rather than added to core/textures.ts) so this module's only touch outside
 * apps/client/src/world/reef/** is the one wiring edit in game/world.ts noted in index.ts.
 */
import * as THREE from 'three';

const SIZE = 64;

function hash2(x: number, z: number): number {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

/** Tileable value noise at a given period (in texels), bilinearly interpolated. */
function valueNoise(x: number, z: number, period: number): number {
  const xf = x / period, zf = z / period;
  const xi = Math.floor(xf), zi = Math.floor(zf);
  const u = xf - xi, v = zf - zi;
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  return a * (1 - su) * (1 - sv) + b * su * (1 - sv) + c * (1 - su) * sv + d * su * sv;
}

const clampByte = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
const smooth01 = (v: number, lo: number, hi: number): number => {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

function makeDataTex(d: Uint8Array): THREE.DataTexture {
  const t = new THREE.DataTexture(d, SIZE, SIZE, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/**
 * Tangent-space normal map simulating coral polyp/corallite texture: a coarse rounded-bump
 * octave (individual polyps) plus a finer grain octave on top — requirement 4's "polyp detail
 * via normal maps". `bumpFreq` is how many bump periods tile across the surface (higher = finer,
 * more tightly-packed polyps, e.g. star coral > brain coral); `strength` scales the apparent
 * relief.
 */
const _polypCache = new Map<string, THREE.DataTexture>();
export function polypNormalTex(bumpFreq: number, strength: number): THREE.DataTexture {
  const key = `${bumpFreq}@${strength}`;
  const cached = _polypCache.get(key);
  if (cached) return cached;
  const height = (x: number, z: number): number =>
    valueNoise(x, z, SIZE / bumpFreq) * 0.7 + valueNoise(x, z, SIZE / (bumpFreq * 2.3)) * 0.3;
  const d = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const hx = height(x + 1, y) - height(x - 1, y);
      const hz = height(x, y + 1) - height(x, y - 1);
      d[i] = clampByte(128 + hx * 420 * strength);
      d[i + 1] = clampByte(128 + hz * 420 * strength);
      d[i + 2] = 255;
      d[i + 3] = 255;
    }
  }
  const t = makeDataTex(d);
  t.repeat.set(bumpFreq, bumpFreq);
  _polypCache.set(key, t);
  return t;
}

/**
 * Alpha-cutout mask for the sea-fan / sea-plume / far-LOD-card flat geometry (see geometry.ts) —
 * a lacy, porous silhouette so a 2-triangle quad reads as a filigreed gorgonian instead of a
 * solid plastic card. Read through `alphaTest`, so triangle count never changes with how lacy it
 * looks.
 */
let _lacy: THREE.DataTexture | null = null;
export function lacyAlphaTex(): THREE.DataTexture {
  if (_lacy) return _lacy;
  const d = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const u = x / SIZE - 0.5, v = y / SIZE - 0.5;
      const r = Math.hypot(u * 2.05, v * 2.25);
      const silhouette = smooth01(1 - r, -0.05, 0.22);
      const holes = valueNoise(x, y, SIZE / 7) * 0.6 + valueNoise(x, y, SIZE / 2.6) * 0.4;
      const a = silhouette > 0.02 && holes > 0.4 ? clampByte(silhouette * 255) : 0;
      d[i] = 235; d[i + 1] = 235; d[i + 2] = 240; d[i + 3] = a;
    }
  }
  _lacy = makeDataTex(d);
  _lacy.wrapS = _lacy.wrapT = THREE.ClampToEdgeWrapping;
  return _lacy;
}

/** A narrower, taller mask for seagrass blade cards (less round, more blade-like). */
let _blade: THREE.DataTexture | null = null;
export function bladeAlphaTex(): THREE.DataTexture {
  if (_blade) return _blade;
  const d = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const u = Math.abs(x / SIZE - 0.5) * 2; // 0 at center, 1 at edges
      const v = y / SIZE; // 0 base, 1 tip
      const width = (1 - v * 0.55) * 0.5; // tapers toward the tip
      const a = u < width ? 255 : 0;
      d[i] = 60; d[i + 1] = 130; d[i + 2] = 70; d[i + 3] = a;
    }
  }
  _blade = makeDataTex(d);
  _blade.wrapS = _blade.wrapT = THREE.ClampToEdgeWrapping;
  return _blade;
}
