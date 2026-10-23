/**
 * World shape: Marathon, Florida Keys.
 *
 * Ported faithfully from legacy/index.html lines 326-357 (plus the Miami island block it
 * depends on, lines 342-350, and the lookup helpers at 353-354). Every magic number, every
 * evaluation order, is preserved exactly — see docs/ARCHITECTURE.md and the Phase 0a task
 * notes. Do not "improve" the maths here (the shorelines are the one deliberate departure; see below).
 *
 * x runs along the island chain (west = -x toward the Seven Mile Bridge, east = +x toward
 * Grassy Key). North (-z) is Florida Bay / the Gulf side; south (+z) is Hawk Channel,
 * Sombrero Reef and the Gulf Stream.
 *
 * Shorelines are no longer the legacy ellipses: every island but the mainland has its real
 * OpenStreetMap outline (coast-data.ts, fitted onto the island's old footprint by
 * scripts/coast/bake.py). The footprint itself (x, z, a, b, th, seed=11) is still legacy's and still
 * places everything that is laid out in island-local coordinates.
 */
import { buildCoast, coastDist, type Coast } from './coast.js';
import { COAST_RINGS } from './coast-data.js';

export const chainZ = (x: number): number => 0.000012 * x * x;

/**
 * Legacy's `srand` (index.html:332) is a Lehmer / Park-Miller multiplicative LCG seeded with a
 * module-level `let seed = 11`, mutated on every call. That mutable global is only ever used to
 * build the island list deterministically at load time (`seed=11` is load-bearing for the
 * island layout — see docs/ARCHITECTURE.md "Seeding"). We keep the exact recurrence but give it
 * to a local closure instead of module-level mutable state, so this module has no side effects
 * at import time beyond computing the (deterministic, side-effect-free) `islands` constant below.
 */
export function createSrand(seed: number): () => number {
  let s = seed;
  return (): number => (s = (s * 16807) % 2147483647) / 2147483647;
}

export interface Island {
  name: string;
  x: number;
  z: number;
  a: number;
  b: number;
  th: number;
  c: number;
  s: number;
  small: boolean;
  mainland?: boolean;
  miami?: boolean;
  noHouses?: boolean;
  /** The real outline; absent for the procedural mainland, which keeps its ellipse. */
  coast?: Coast;
}

export interface ShoreInfo {
  /** Signed distance outside the nearest island's shore, metres (negative on land). */
  d: number;
  /** The nearest island, or null if (in principle) none exists. */
  isl: Island | null;
  /** The same distance on legacy's normalized scale (see `islandE`): <1 inside, >1 outside. */
  e: number;
}

// Real islands of the Marathon chain: [name, x, dz (offset from chainZ(x)), semi-axis a, semi-axis b]
const ISL_DEF: Array<[string, number, number, number, number]> = [
  ['Little Duck Key', -3860, 10, 230, 120], ['Pigeon Key', -2650, -62, 70, 42], ["Knight's Key", -2080, 0, 170, 110],
  ['Marathon (Vaca Key)', -120, 0, 1680, 270], ['Boot Key', -1050, 560, 620, 170], ['Fat Deer Key', 1990, -30, 380, 230],
  ['Key Colony Beach', 2050, 330, 260, 110], ['Crawl Key', 2750, -20, 300, 170], ['Grassy Key', 3640, -10, 520, 190],
  ['East Sister Rock', 900, 560, 42, 30], ['Molasses Keys', -3150, 520, 70, 36],
  ['Rachel Key', -1250, -950, 95, 55], ['Bamboo Key', 350, -1350, 140, 70], ['Money Key', 1450, -850, 80, 50],
  ['Bay mangroves', -2600, -1500, 120, 70], ['Florida mainland (Miami)', 0, -3500, 6600, 760],
];

// Miami, laid out from the real geography of Biscayne Bay (scaled about 1:4 and turned so the city faces
// south onto the bay): Downtown and Brickell on the mainland, the Miami River, Brickell Key, PortMiami on
// Dodge Island, Watson, Star, Palm and Hibiscus islands along the MacArthur Causeway, the Venetian Islands,
// Fisher Island, Government Cut, Miami Beach, and Virginia Key and Key Biscayne at the end of the
// Rickenbacker Causeway. [name, x, z, semi-axis a, semi-axis b] — these are absolute z, not chainZ-relative.
const MIAMI_ISL: Array<[string, number, number, number, number]> = [
  ['Brickell Key', 2088, -2652, 62, 50], ['Dodge Island (PortMiami)', 2300, -2302, 75, 338], ['Watson Island', 2525, -2565, 75, 62],
  ['Star Island', 2575, -2165, 31, 100], ['Hibiscus Island', 2625, -2290, 22, 90], ['Palm Island', 2700, -2290, 25, 125], ['Fisher Island', 2200, -1865, 112, 87],
  ['Miami Beach', 3280, -1690, 900, 150], ['Venetian Islands', 2950, -2540, 30, 55], ['Venetian Islands', 2950, -2390, 30, 55], ['Venetian Islands', 2950, -2240, 30, 55], ['Venetian Islands', 2950, -2090, 30, 55],
  ['Virginia Key', 1425, -2040, 275, 225], ['Key Biscayne', 380, -1790, 740, 250],
];

const MIAMI_NO_HOUSES = ['Miami Beach', 'Dodge Island (PortMiami)', 'Brickell Key', 'Virginia Key'];

function buildIslands(): Island[] {
  // seed=11 EXACTLY, per docs/ARCHITECTURE.md "Seeding" — this is load-bearing for island placement.
  const srand = createSrand(11);
  const islands: Island[] = ISL_DEF.map(([name, x, dz, a, b]) => {
    const z = chainZ(x) + dz, th = Math.atan2(0.000024 * x, 1) + (a < 150 ? (srand() - 0.5) * 1.2 : 0);
    return { name, x, z, a, b, th, c: Math.cos(th), s: Math.sin(th), small: a < 150, mainland: name.startsWith('Florida mainland') };
  });
  MIAMI_ISL.forEach(([name, x, z, a, b]) => islands.push({
    name, x, z, a, b, th: 0, c: 1, s: 0, small: a < 150 && b < 150, miami: true, noHouses: MIAMI_NO_HOUSES.includes(name),
  }));
  islands.forEach((I, i) => { const r = COAST_RINGS[i]; if (r) I.coast = buildCoast(r); });
  return islands;
}

/** All islands, Marathon chain plus Miami, in legacy build order. Pure, deterministic — see buildIslands. */
export const islands: Island[] = buildIslands();

const ISL: Record<string, Island> = Object.fromEntries(islands.map((I) => [I.name, I]));

export const VACA: Island = ISL['Marathon (Vaca Key)'];
export const BOOT: Island = ISL['Boot Key'];
export const KCB: Island = ISL['Key Colony Beach'];

/** Look up an island by its exact legacy name (as used in ISL_DEF / MIAMI_ISL). */
export function getIsland(name: string): Island | undefined {
  return ISL[name];
}

/** World (x,z) -> island-local (lx,lz), rotated into the island's own frame. */
export function islandLocal(I: Island, x: number, z: number): [number, number] {
  const dx = x - I.x, dz = z - I.z;
  return [dx * I.c + dz * I.s, -dx * I.s + dz * I.c];
}

/** Island-local (lx,lz) -> world (x,z). */
export function islandWorld(I: Island, lx: number, lz: number): [number, number] {
  return [I.x + lx * I.c - lz * I.s, I.z + lx * I.s + lz * I.c];
}

/**
 * Legacy measured the shore on each ellipse's own scale: e = 1 on the shore, d = (e - 1) * (a + b) / 2.
 * landH's beach and everything else keyed to `e` keep that meaning, with one change for the real
 * outlines: the scale is capped at SHORE_SCALE metres, so a big island's beach is ~20 m wide instead
 * of a tenth of the island (which on Vaca's ~100 m-wide stretches would have left no dry land).
 */
export const SHORE_SCALE = 120;

function shoreScale(I: Island): number {
  return I.coast ? Math.min((I.a + I.b) * 0.5, SHORE_SCALE) : (I.a + I.b) * 0.5;
}

/** Signed distance outside island I's shore, metres. */
export function islandDist(I: Island, x: number, z: number): number {
  if (I.coast) return coastDist(I.coast, x, z);
  const l = islandLocal(I, x, z);
  return (Math.hypot(l[0] / I.a, l[1] / I.b) - 1) * (I.a + I.b) * 0.5;
}

/** Island I's normalized shore radius at (x, z): <1 on land, 1 on the shore, >1 at sea. */
export function islandE(I: Island, x: number, z: number): number {
  if (!I.coast) { const l = islandLocal(I, x, z); return Math.hypot(l[0] / I.a, l[1] / I.b); }
  return 1 + coastDist(I.coast, x, z) / shoreScale(I);
}

/** World-space box around island I's land. */
export function islandBox(I: Island): { x0: number; z0: number; x1: number; z1: number } {
  if (I.coast) return { x0: I.coast.x0, z0: I.coast.z0, x1: I.coast.x1, z1: I.coast.z1 };
  const hx = Math.hypot(I.a * I.c, I.b * I.s), hz = Math.hypot(I.a * I.s, I.b * I.c);
  return { x0: I.x - hx, z0: I.z - hz, x1: I.x + hx, z1: I.z + hz };
}

/** Nearest-island shoreline query: distance outside the shore, the island itself, and `e`. */
export function shoreInfo(x: number, z: number): ShoreInfo {
  let best = 1e9, bi: Island | null = null;
  for (const I of islands) {
    const d = islandDist(I, x, z);
    if (d < best) { best = d; bi = I; }
  }
  return { d: best, isl: bi, e: bi ? islandE(bi, x, z) : 9 };
}
