/**
 * Seafloor heightfield: pure sampling of real bathymetry for the chunked LOD terrain built in
 * ./chunk.ts / ./lod.ts, plus the public `seafloorHeightAt`/`seafloorNormalAt` API that
 * ../seafloor.ts re-exports for other systems (reef coral placement, diver ground collision).
 *
 * Starting point: legacy/index.html:707-729's floor colour ramp (sand/grass/rubble/coral/deep),
 * extended per docs/ARCHITECTURE.md's "underwater world" depth-band table (flats, patch reef,
 * reef wall top, ledges, deep wall — see the band constants below). Height now comes straight
 * from real bathymetry instead of legacy's `-(0.25+min(d,14)*0.55)` crush — see ../seafloor.ts's
 * header for why `floorY` itself is kept (now identity) rather than removed.
 */
import { depthFast } from '@keysrun/shared/sim/depth-grid';
import { chainZ } from '@keysrun/shared/world/chain';
import { HUMPS } from '@keysrun/shared/world/depth';

export const CHUNK_SIZE = 64;

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

type RGB = [number, number, number];
const L3 = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** legacy `hash2` (index.html:709) — cheap deterministic pseudo-noise for cosmetic speckling
 * (not gameplay-relevant placement, so plain Math is fine here — see docs/ARCHITECTURE.md
 * "Seeding" for the distinction). */
const hash2 = (x: number, z: number): number => {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

/**
 * Ground height (world Y; negative underwater) at world (x,z). This is the single source of
 * truth for where the seafloor is: the chunked mesh samples exactly this, so anything that calls
 * it — reef coral placement, diver ground collision, this module's own colouring — agrees with
 * what's actually rendered. Uses the cached `depthFast` grid (10 m spacing, bilinearly
 * interpolated) rather than the exact `depthAt`, per docs/ARCHITECTURE.md's "use depthFast/the
 * cached depth grid where it's hot" — this runs for every terrain vertex and potentially every
 * frame of ground collision, so it has to stay cheap. depthAt's own periodic terms all have
 * wavelengths well above 10 m, so the grid's interpolation error against the true closed-form
 * function is negligible.
 */
export function seafloorHeightAt(x: number, z: number): number {
  return -depthFast(x, z);
}

/**
 * Surface normal at (x,z) via central differences on `seafloorHeightAt`. Cheap enough for
 * placement-time use (e.g. the reef system orienting coral to the local slope); chunk.ts derives
 * its own per-vertex shading straight from the height grid it already built instead of calling
 * this per vertex.
 */
export function seafloorNormalAt(x: number, z: number, eps = 1): { x: number; y: number; z: number } {
  const hL = seafloorHeightAt(x - eps, z), hR = seafloorHeightAt(x + eps, z);
  const hD = seafloorHeightAt(x, z - eps), hU = seafloorHeightAt(x, z + eps);
  const dx = (hR - hL) / (2 * eps), dz = (hU - hD) / (2 * eps);
  const nx = -dx, ny = 1, nz = -dz, len = Math.hypot(nx, ny, nz) || 1;
  return { x: nx / len, y: ny / len, z: nz / len };
}

// ---- biome palette -------------------------------------------------------------------------
// Depth bands per docs/ARCHITECTURE.md "The underwater world" table:
//   1   0-5 m   seagrass flats, sand
//   2   5-10 m  patch reef ("reds are gone")
//   3  10-15 m  reef wall top, elkhorn/staghorn
//   4  15-20 m  ledges, overhangs
//   5  20 m+    deep wall, wrecks
const SAND: RGB = [0.93, 0.86, 0.66];
const GRASS: RGB = [0.30, 0.47, 0.24];
const RUBBLE: RGB = [0.56, 0.49, 0.37];
const LEDGE_ROCK: RGB = [0.20, 0.25, 0.30];
const DEEP: RGB = [0.03, 0.08, 0.18];
// Band 3 (10-15 m, reef wall top): warm elkhorn/staghorn tones.
const CORAL_WARM: RGB[] = [[0.85, 0.55, 0.30], [0.90, 0.62, 0.25], [0.80, 0.45, 0.35], [0.70, 0.55, 0.30]];
// Band 2 (5-10 m, patch reef): "reds are gone" — cooler, red-suppressed swatches standing in for
// the real per-channel extinction (that's a camera-distance fragment-shader effect owned
// elsewhere, per docs/ARCHITECTURE.md "Rendering"); this just makes the dry vertex colour
// underneath it look the part.
const CORAL_MUTED: RGB[] = [[0.50, 0.42, 0.50], [0.42, 0.46, 0.44], [0.46, 0.40, 0.46], [0.38, 0.46, 0.44]];

/**
 * True near the main reef wall corridor (dz 1460-1650, widened either side for a soft transition)
 * or one of the two offshore patch-reef HUMPS — the same regions world/coral.ts scatters actual
 * coral instances over, so the floor underneath reads as reef rather than plain sand. (The ten
 * random Hawk Channel patch-reef clusters coral.ts also seeds via hashCell are *not* reproduced
 * here — their positions depend on client-only RNG salts this pure module has no business
 * importing — so the floor under those shows as plain sand/grass even though a coral instance
 * sits on it; a cosmetic gap, not a structural one.)
 */
function isReefy(x: number, dz: number, d: number): boolean {
  if (d >= 20) return false;
  if (dz > 1150 && dz < 1750) return true;
  for (const H of HUMPS) {
    if (H.patch && Math.hypot(x - H.x, dz - H.dz) < 130) return true;
  }
  return false;
}

/**
 * Biome vertex colour at world (x,z), given its depth `d` (pass a value already sampled by the
 * caller — e.g. from the chunk's own height grid — so this never re-samples depthFast). `shade`
 * is an optional 0..1 darkening factor (1 = unchanged); chunk.ts derives it from local slope so
 * steep faces — the reef wall itself — pick up a bit of built-in ambient occlusion.
 */
export function seafloorColorAt(x: number, z: number, d: number, shade = 1): RGB {
  const dz = z - chainZ(x);
  const n = Math.sin(x * 0.05) * Math.cos(z * 0.043) + Math.sin(x * 0.013 + z * 0.021);
  let c = L3(SAND, GRASS, clamp(n * 0.6 + 0.4 - (d < 1 ? 0.6 : 0), 0, 1) * (dz < 0 ? 0.9 : 0.55));

  if (isReefy(x, dz, d)) {
    const h = hash2(x, z);
    const swatches = d < 10 ? CORAL_MUTED : CORAL_WARM;
    const swatch = swatches[Math.floor(hash2(z, x) * swatches.length) % swatches.length];
    const base = d >= 15 ? LEDGE_ROCK : RUBBLE;
    const rc = L3(base, swatch, smoothstep(0.45, 0.85, h));
    c = L3(c, rc, 0.75);
  }
  // Dramatic fade to deep blue — this, plus the un-crushed height, is what makes the reef wall
  // (3.4 m -> 45.4 m over 190 m) actually read as a wall instead of the old flat crush.
  c = L3(c, DEEP, clamp((d - 13) / 22, 0, 1));
  const j = (0.94 + hash2(x * 0.7, z * 0.3) * 0.12) * shade;
  return [c[0] * j, c[1] * j, c[2] * j];
}
