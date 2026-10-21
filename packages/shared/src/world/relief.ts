/**
 * Seafloor relief: the rock, coral and ledge structure laid on top of `depthAt`'s smooth
 * bathymetry — outcrops, coral heads, spur-and-groove, wall terraces, sand waves.
 *
 * WHY A SEPARATE LAYER and not edits inside `depthAt`. `depthAt` is the authority for boats, race
 * buoys, party-boat moorings, minimap contours, the water shader's depth texture and the server's
 * aground envelope, and `boat-trajectory.test.ts` pins boat motion to the legacy implementation's
 * output bit-for-bit through `depthFast`'s grid of it. Adding 3 m rocks into `depthAt` would move
 * every one of those: buoys would land on rock, party boats would ground on coral, and the
 * legacy-trajectory fixtures would fail wherever a track crossed a reef. None of those systems can
 * see a coral head from a boat anyway. So `depthAt` keeps meaning "navigable water depth, smooth",
 * and this module is "how the actual floor deviates from it", consumed only by what renders or
 * collides with the floor (the terrain mesh, diver collision, coral seating, seep vents).
 * `depthAt` is untouched, so race.test.ts and party-boats.test.ts need no placement changes.
 *
 * Pure and deterministic like `depthAt`: closed form, integer hashing, no RNG, no module state, no
 * three.js. Server and client agree to the bit, which matters because the diver collides with it.
 *
 * SAFETY RAILS (each one is a test in test/relief.test.ts):
 *  - Never raises the floor to within `RELIEF_MIN_TOP` (2.3 m) of the surface, and never above 70%
 *    of the local depth, so no rock reaches a keel or the waterline even if a boat is drawn over it.
 *  - Zero in the Florida Bay / backcountry, the flats and the bridge cuts (dz < 150, or d < ~2.6).
 *  - Grooves never dig deeper than 1.1 m or a third of the local depth.
 *  - Bounded slope: the steepest face is a ledge, not a needle (the mesh is a heightfield).
 */
import { chainZ } from './chain.js';
import { chainTangent } from './current.js';
import { HUMPS } from './depth.js';
import { clamp } from '../internal/math.js';

/** Shallowest the relief may bring the floor, metres below the surface. */
export const RELIEF_MIN_TOP = 2.3;

/** Integer hash -> [0,1). Avalanche from murmur3's finaliser; identical on every engine. */
function h32(a: number, b: number, s: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Probability tables by zone — see `zoneWeights`. */
interface Zone { hawk: number; reef: number; patch: number }

function zoneWeights(x: number, dz: number): Zone {
  const hawk = smooth(250, 700, dz) * (1 - smooth(1150, 1300, dz));
  const reef = smooth(1150, 1300, dz) * (1 - smooth(1700, 1900, dz));
  let patch = 0;
  for (const H of HUMPS) {
    if (!H.patch) continue;
    patch = Math.max(patch, 1 - smooth(60, 190, Math.hypot(x - H.x, dz - H.dz)));
  }
  return { hawk, reef, patch };
}

/**
 * Rock outcrops: 6-16 m wide, 1-5 m tall, steep flanks, a terraced (ledged) body and a lumpy top.
 * 48 m cells with a jittered centre; radius <= 16 m so the 3x3 neighbourhood always contains every
 * rock that can touch the point. Overlaps take the max (rocks fuse, they do not stack).
 */
function outcrops(x: number, z: number, zone: Zone): number {
  const p = 0.1 * zone.hawk + 0.36 * zone.reef + 0.45 * zone.patch;
  if (p < 0.005) return 0;
  const CELL = 48;
  const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL);
  let best = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cz = iz + j;
      if (h32(cx, cz, 11) > p) continue;
      const ox = (cx + 0.15 + 0.7 * h32(cx, cz, 12)) * CELL, oz = (cz + 0.15 + 0.7 * h32(cx, cz, 13)) * CELL;
      const R = 6 + 10 * h32(cx, cz, 14);
      const dx = x - ox, dz = z - oz;
      const dist = Math.hypot(dx, dz);
      if (dist > R * 1.4) continue;
      const ang = Math.atan2(dz, dx);
      // lobed outline: a rock is never a circle
      const q = dist / (R * (1 + 0.22 * Math.sin(3 * ang + 6.28 * h32(cx, cz, 15)) + 0.12 * Math.sin(5 * ang + 6.28 * h32(cx, cz, 16))));
      if (q >= 1) continue;
      const H = 1.2 + 3.8 * h32(cx, cz, 17) * h32(cx, cz, 18);
      const prof = smooth(0, 0.45, 1 - q);
      // ledges: blend the smooth dome with a 3-step terrace of the same profile
      const t = prof * 3, fl = Math.floor(t);
      const terrace = (fl + smooth(0.55, 1, t - fl)) / 3;
      // two octaves of lumpiness (4-9 m and 3 m wavelengths): the first screenshots showed the
      // outcrops as smooth domes, which reads as a hill, not a rock. 3 m is about the finest the
      // 2 m near-ring grid can carry.
      const lump = 1 + 0.2 * Math.sin(x * 0.85 + 1) * Math.sin(z * 0.7) + 0.12 * Math.sin(x * 1.9 + z * 1.3);
      best = Math.max(best, H * (0.5 * prof + 0.5 * terrace) * lump);
    }
  }
  return best;
}

/** Coral heads / bommies: 1.4-3.8 m wide mushroom domes, 0.7-2 m tall, dense on the reef. */
function coralHeads(x: number, z: number, zone: Zone): number {
  const p = 0.09 * zone.hawk + 0.5 * zone.reef + 0.7 * zone.patch;
  if (p < 0.005) return 0;
  const CELL = 14;
  const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL);
  let best = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cz = iz + j;
      if (h32(cx, cz, 21) > p) continue;
      const ox = (cx + 0.2 + 0.6 * h32(cx, cz, 22)) * CELL, oz = (cz + 0.2 + 0.6 * h32(cx, cz, 23)) * CELL;
      const R = 1.4 + 2.4 * h32(cx, cz, 24);
      const dx = x - ox, dz = z - oz;
      const d2 = (dx * dx + dz * dz) / (R * R);
      if (d2 >= 1) continue;
      const H = 0.7 + 1.3 * h32(cx, cz, 25);
      const ang = Math.atan2(dz, dx);
      best = Math.max(best, H * Math.pow(1 - d2, 0.6) * (0.88 + 0.12 * Math.sin(ang * 6 + 6.28 * h32(cx, cz, 26))));
    }
  }
  return best;
}

/**
 * The raw (unclamped) relief, metres up (+) / down (-) from `depthAt`'s floor, before `reliefAt`
 * gates and clamps it against the local depth. Evaluated per terrain vertex.
 */
function rawRelief(x: number, z: number, dz: number): number {
  const zone = zoneWeights(x, dz);
  let r = Math.max(outcrops(x, z, zone), coralHeads(x, z, zone));

  // Spur-and-groove on the reef front (crest -> upper wall): fingers of coral pointing seaward
  // separated by sand grooves, ~30 m apart along the chain, wandering a little in both coordinates
  // so they are not a ruler-straight comb.
  const sg = smooth(1290, 1340, dz) * (1 - smooth(1560, 1680, dz));
  if (sg > 0) {
    const { tx, tz } = chainTangent(x);
    const s = x * tx + z * tz;
    const phase = (s / 30) * Math.PI * 2 + 1.6 * Math.sin(s / 170) + 0.5 * Math.sin(dz / 55);
    const spur = Math.pow(0.5 + 0.5 * Math.sin(phase), 1.7);
    r += sg * 1.7 * (spur - 0.38);
  }

  // Wall terraces: the 3.4 -> 45 m drop is a staircase of shelves and steep risers, not a ramp.
  // 1.5 m of amplitude at 34 m wavelength against a 0.22 slope flattens the shelf and steepens the
  // riser without ever reversing the slope into an overhang (a heightfield cannot draw one).
  const wm = smooth(1440, 1480, dz) * (1 - smooth(1630, 1670, dz));
  if (wm > 0) r += wm * 1.5 * Math.sin((dz / 34) * Math.PI * 2 + 0.011 * x + 1.3 * Math.sin(x / 140));

  // Low sand waves over the soft bottom, so open sand is not a billiard table. Centimetres, not
  // metres: it is shading, not structure.
  const sand = smooth(300, 600, dz);
  if (sand > 0) r += sand * 0.15 * Math.sin(0.19 * x + 0.6 * Math.sin(0.05 * z)) * Math.sin(0.15 * z);
  return r;
}

/**
 * Height (m, + = up) the real floor stands above `depthAt`'s smooth floor at (x,z). Pass the base
 * depth `d` (`depthAt(x,z)` or the grid's `depthFast`). Always 0 where it must not apply.
 */
export function reliefAt(x: number, z: number, d: number): number {
  const dz = z - chainZ(x);
  const gate = smooth(150, 300, dz) * smooth(2.6, 4.2, d);
  if (gate <= 0) return 0;
  const r = rawRelief(x, z, dz) * gate;
  if (r >= 0) {
    const cap = Math.min(Math.max(0, d - RELIEF_MIN_TOP), 0.7 * d);
    return cap > 1e-6 ? cap * Math.tanh(r / cap) : 0;
  }
  const g = Math.min(1.1, Math.max(0, 0.3 * (d - 2)));
  return g > 1e-6 ? -g * Math.tanh(-r / g) : 0;
}

/** Depth (m) of the actual floor at (x,z): `depthAt` minus the relief. For anything that needs
 * where the bottom really is rather than where the navigable-water model says it is. */
export function floorDepthAt(x: number, z: number, d: number): number {
  return d - reliefAt(x, z, d);
}
