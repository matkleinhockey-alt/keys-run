/**
 * Bathymetry and zone geography for Marathon, Florida Keys.
 *
 * Ported faithfully from legacy/index.html lines 358-432 (plus WORLD/WB at 330-331). Every
 * magic number and evaluation order is preserved exactly — see docs/ARCHITECTURE.md and the
 * Phase 0a task notes. `depthAt`/`landH` are the pure closed-form bathymetry functions the
 * whole game (and later, server) is built on; do not "improve" the maths here.
 */

import { chainZ, islandBox, islandDist, islandE, islandLocal, islands, shoreInfo, VACA, KCB, type Island } from './chain.js';
import { clamp, lerp } from '../internal/math.js';

export const WORLD = { x0: -4300, z0: -3100, size: 8600 };
export const WB = { x0: -4150, x1: 4150, z0: -2950, z1: 5350 };

export interface Hump {
  name: string;
  x: number;
  dz: number;
  patch?: boolean;
}

// Three real Marathon dive sites (Sombrero Reef, Coffins Patch, Delta Shoal) plus the offshore humps.
export const HUMPS: Hump[] = [
  { name: 'Marathon Hump', x: -500, dz: 3350 },
  { name: 'West Hump', x: -2700, dz: 3650 },
  { name: 'Coffins Patch', x: 2700, dz: 1050, patch: true },
  { name: 'Delta Shoal', x: 1250, dz: 1300, patch: true },
];

/**
 * Where the swell stands up and breaks: a bar off the mainland beach, north of the chain.
 *
 * Everywhere else in this world gets calmer as it gets shallower — `ampFor` grows with depth, so
 * the flats are glass and the Gulf Stream has the rollers. That is right for the Keys and wrong
 * for a beach: real swell shoals, steepening as the bottom comes up under it, and breaks. This is
 * the one place that happens, so there is somewhere to go and find surf.
 *
 * `r` is where the break fades out entirely; the steep water is the inner half of it.
 */
export const SURF_BREAK = { name: 'The Mainland Bar', x: 600, z: -2672, r: 300 } as const;

export interface Channel {
  x0: number;
  x1: number;
  dz0: number;
  dz1: number;
  d: number;
}

export const CHANNELS: Channel[] = [
  { x0: -1700, x1: -480, dz0: 200, dz1: 430, d: 3.8 },
  { x0: -2000, x1: -1560, dz0: 150, dz1: 800, d: 4.2 },
  { x0: -1750, x1: -1350, dz0: -420, dz1: -180, d: 3.4 },
  { x0: -800, x1: -420, dz0: -420, dz1: -180, d: 3.4 },
];

export interface MiamiChannel {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  d: number;
}

export const MIAMI_CH: MiamiChannel[] = [
  { x0: 2312, x1: 2380, z0: -2010, z1: -1420, d: 13 },
  { x0: 2376, x1: 2480, z0: -2640, z1: -1950, d: 11 },
  { x0: 2140, x1: 2224, z0: -2640, z1: -1960, d: 9 },
  { x0: 2224, x1: 2380, z0: -2740, z1: -2640, d: 8 },
];

export interface GolfCourse {
  I: Island;
  lx: number;
  lz: number;
  ra: number;
  rb: number;
  holes: number;
  name: string;
}

// golf: Sombrero Country Club on Vaca Key, the par-3 at Key Colony Beach. Placed where the real
// outlines have the most land under them; landH fills the rest (see inFill).
export const GOLF: GolfCourse[] = [
  { I: VACA, lx: 330, lz: 100, ra: 290, rb: 150, holes: 4, name: 'Sombrero Country Club' },
  { I: KCB, lx: -30, lz: 30, ra: 175, rb: 72, holes: 3, name: 'Key Colony Beach golf' },
];

export interface Runway {
  I: Island;
  lx0: number;
  lx1: number;
  lz: number;
  w: number;
}

// Airport runway on Vaca Key, along the widest run of the real island east of the golf course.
export const RUNWAY: Runway = { I: VACA, lx0: 700, lx1: 1420, lz: 80, w: 34 };

/** True if the island-local point (lx,lz) on island I lies on a golf course or the runway. */
export function onCourse(I: Island, lx: number, lz: number): boolean {
  for (const G of GOLF) {
    if (G.I === I && Math.hypot((lx - G.lx) / G.ra, (lz - G.lz) / G.rb) < 1.06) return true;
  }
  return I === RUNWAY.I && lx > RUNWAY.lx0 - 30 && lx < RUNWAY.lx1 + 30 && Math.abs(lz - RUNWAY.lz) < RUNWAY.w;
}

export interface Marina {
  name: string;
  isl: Island;
  sx: number;
  sz: number;
  dir: number;
  ex: number;
  ez: number;
}

/**
 * The dredged entrance every marina basin needs to be a marina.
 *
 * The basins are dredged to 3.2 m but nothing connected them to navigable water, and two of the
 * four were walled in. Walking out along its own axis, the town marina ran 3.2 m to 70 m, then
 * 0.5 and 0.4, then seventy metres of LAND standing 1.7 m proud, and only then the 3.8 m of the
 * harbour approach. Keys Fisheries had a 50 m shoal of 0.4 m across its mouth. A flood fill from
 * the dock confirmed it: at 1.15 m of draft — the MTI, the deepest hull in the game — the town
 * marina was LANDLOCKED, and the shallower boats only got in by a 930 m detour west. There is no
 * approach to find; the player was right.
 *
 * So: a cut from the end of the basin out to where the water is, 32 m wide, dredged to the same
 * 3.2 m, feathered at the edges rather than a square trench. It carves land as well as depth,
 * because at the town marina the barrier IS land — the same thing `creekDist` does for the
 * mangrove creeks, and for the same reason.
 *
 * It is applied to all four. The two that were already clear have no land in the corridor and
 * more than 3.2 m in it, so for them every term here is a no-op.
 */
const MARINA_CUT = { r0: 66, r1: 155, halfW: 16, d: 3.2, feather: 9 } as const;

/**
 * How far INSIDE a marina entrance cut a point is, in metres — 0 at the edge, growing toward the
 * centreline, and negative outside. Shaped like `creekDist` so it can be used the same way.
 */
export function marinaCutDepth(x: number, z: number): number {
  let best = -1e9;
  for (const M of MARINAS) {
    const r = (z - M.sz) * M.dir;
    if (r < MARINA_CUT.r0 || r > MARINA_CUT.r1) continue;
    // Taper the last stretch shut so the cut meets open water instead of ending in a step.
    const endFade = Math.min(1, (MARINA_CUT.r1 - r) / 18);
    const inside = (MARINA_CUT.halfW - Math.abs(x - M.sx)) * endFade;
    if (inside > best) best = inside;
  }
  return best;
}

// marinas: two in Boot Key Harbor, two on the Gulf side
export const MARINAS: Marina[] = (
  [
    ['Boot Key Harbor City Marina', VACA, -900, 1],
    ['Burdines Waterfront', VACA, -1400, 1], // clear of the canal fingers at -1380
    ['Faro Blanco Marina', VACA, -1560, -1],
    ['Keys Fisheries', VACA, -600, -1],
  ] as Array<[string, Island, number, number]>
).map(([name, I, sx, dir]) => {
  // march from the island's middle out to sea; the shore is where it leaves land for good water
  let sz = I.z, land = false;
  for (let k = 0; k < 1200; k++) {
    const z = I.z + dir * k * 0.5, e = islandE(I, sx, z);
    if (e < 1) land = true;
    else if (land && e >= 1.03) { sz = z; break; }
  }
  return { name, isl: I, sx, sz, dir, ex: sx, ez: sz + dir * 48 };
});

/**
 * The town is built on fill. Real Vaca is cut by finger canals, and the pad (world/town.ts: PAD, in
 * the frame of MARINAS[0]) is wider than some of the land under it, so landH raises the ground
 * across the pad's footprint (see inFill). Kept here rather than read from town.ts, which imports
 * this module; town.test.ts checks this box still covers PAD.
 */
export const TOWN_FILL = { u0: -112, u1: 112, v0: 14, v1: 180 } as const;

/**
 * US-1 runs along chainZ (world/bridge.ts in the client). The real outlines do not follow that
 * parabola exactly: on Vaca the line leaves the land for a lagoon or a few metres of Florida Bay,
 * and on Fat Deer/Crawl it cuts across canal mouths. So each key the highway crosses gets a fill
 * causeway along the line, from its first to its last solid land on it, US1_HALF metres either side
 * — the road stays a road across its own key, and the channels between keys stay bridges.
 */
export const US1_HALF = 9;
const US1_KEYS = ['Little Duck Key', "Knight's Key", 'Marathon (Vaca Key)', 'Fat Deer Key', 'Crawl Key', 'Grassy Key'];
const US1_RUNS: ReadonlyArray<readonly [number, number]> = US1_KEYS.map((name) => {
  const I = islands.find((J) => J.name === name)!, b = islandBox(I);
  let x0 = Infinity, x1 = -Infinity;
  for (let x = b.x0; x <= b.x1; x += 2) {
    if (islandDist(I, x, chainZ(x)) < -4) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  }
  return [x0, x1] as const;
}).filter(([a, b]) => b > a);

/** True on US-1's causeway fill (see US1_RUNS). */
export function onUS1Fill(x: number, z: number): boolean {
  if (Math.abs(z - chainZ(x)) > US1_HALF) return false;
  for (const [a, b] of US1_RUNS) if (x >= a && x <= b) return true;
  return false;
}

/** Made ground: US-1's causeways, the town pad, the golf courses and the airfield (runway, apron and terminal, see
 * world/islands.ts buildRunway), which sit flat across the canals the real outlines have. */
function inFill(x: number, z: number): boolean {
  if (onUS1Fill(x, z)) return true;
  const M = MARINAS[0], u = M.dir * (x - M.sx), v = M.dir * (M.sz - z);
  if (u >= TOWN_FILL.u0 && u <= TOWN_FILL.u1 && v >= TOWN_FILL.v0 && v <= TOWN_FILL.v1) return true;
  for (const G of GOLF) {
    const [lx, lz] = islandLocal(G.I, x, z);
    if (Math.hypot((lx - G.lx) / G.ra, (lz - G.lz) / G.rb) < 1.03) return true;
  }
  const [lx, lz] = islandLocal(RUNWAY.I, x, z);
  return lx > RUNWAY.lx0 - 30 && lx < RUNWAY.lx1 + 30 && lz > RUNWAY.lz - RUNWAY.w / 2 - 4 && lz < RUNWAY.lz + 95;
}

export interface Creek {
  name: string;
  pts: Array<[number, number]>;
  w: number;
  bx0: number;
  bx1: number;
  bz0: number;
  bz1: number;
}

const ssX = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

function snake(name: string, x0: number, dz0: number, x1: number, dz1: number, amp: number, waves: number, w: number): Creek {
  const z0 = chainZ(x0) + dz0, z1 = chainZ(x1) + dz1, dx = x1 - x0, dz = z1 - z0, L = Math.hypot(dx, dz), px = -dz / L, pz = dx / L, N = Math.ceil(L / 8), pts: Array<[number, number]> = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N, off = amp * Math.sin(u * Math.PI * 2 * waves) * Math.pow(Math.sin(u * Math.PI), 0.35);
    pts.push([x0 + dx * u + px * off, z0 + dz * u + pz * off]);
  }
  let bx0 = 1e9, bx1 = -1e9, bz0 = 1e9, bz1 = -1e9;
  pts.forEach((p) => { bx0 = Math.min(bx0, p[0]); bx1 = Math.max(bx1, p[0]); bz0 = Math.min(bz0, p[1]); bz1 = Math.max(bz1, p[1]); });
  return { name, pts, w, bx0: bx0 - w - 30, bx1: bx1 + w + 30, bz0: bz0 - w - 30, bz1: bz1 + w + 30 };
}

// winding creeks cut through the keys and the mainland (snake-like mangrove channels and the river through the city)
export const CREEKS: Creek[] = [
  snake('Snake Creek', 620, -400, 700, 400, 70, 1.5, 34),
  snake('Sister Creek', -700, 360, -640, 790, 38, 1.5, 28),
  snake('Grassy Key creek', 3450, -320, 3560, 320, 42, 1.2, 24),
  snake('Miami River', 2150, -2620, 2650, -4300, 170, 2.5, 48),
  snake('Mangrove river', -2400, -2620, -2950, -4100, 150, 3, 32),
  snake('Little River', 3650, -2640, 3950, -3700, 70, 2, 26),
];

/** Signed distance to the nearest creek centerline, negative inside the creek's width. */
export function creekDist(x: number, z: number): number {
  let best = 1e9;
  for (const C of CREEKS) {
    if (x < C.bx0 || x > C.bx1 || z < C.bz0 || z > C.bz1) continue;
    const P = C.pts;
    for (let i = 0; i < P.length - 1; i++) {
      const ax = P[i][0], az = P[i][1], bx = P[i + 1][0], bz = P[i + 1][1], vx = bx - ax, vz = bz - az, l2 = vx * vx + vz * vz;
      const t = clamp(((x - ax) * vx + (z - az) * vz) / l2, 0, 1), d = Math.hypot(x - ax - vx * t, z - az - vz * t) - C.w / 2;
      if (d < best) best = d;
    }
  }
  return best;
}

/** Ground height: beaches slope into the water, creeks carve through, golf courses/runway are graded flat. */
export function landH(x: number, z: number): number {
  const s = shoreInfo(x, z), e = s.e;
  if (e > 1.08) return inFill(x, z) ? 1.6 : -2;
  let h = -1.2 + 2.85 * ssX(1.07, 0.9, e);
  // the real keys are flat (1-2 m): a gentler roll than the mainland's, which keeps legacy's
  if (e < 0.92) h += (s.isl?.coast ? 0.15 : 0.25) * (Math.sin(x * 0.021) * Math.cos(z * 0.017) + Math.sin(x * 0.0063 + z * 0.0081)) * ssX(0.92, 0.72, e);
  const l = islandLocal(s.isl as Island, x, z);
  if (onCourse(s.isl as Island, l[0], l[1])) h = Math.min(h, 1.85);
  const cd = creekDist(x, z);
  if (cd < 10) h = Math.min(h, lerp(-1.6, h, ssX(-2, 10, cd)));
  // The dredged marina entrance (MARINA_CUT). Below the creek cut so a basin mouth that happens
  // to sit on a creek keeps the deeper of the two, and above `inFill` so the marina's own pad is
  // never carved out from under its docks.
  const mc = marinaCutDepth(x, z);
  if (mc > -MARINA_CUT.feather) h = Math.min(h, lerp(h, -1.6, clamp((mc + MARINA_CUT.feather) / MARINA_CUT.feather, 0, 1)));
  if (inFill(x, z)) h = Math.max(h, 1.6);
  return h;
}

/** 0 inshore, ramping to 1 well out in the Gulf Stream (legacy's `offshoreF`). */
export const offshoreF = (x: number, z: number): number => clamp((z - chainZ(x) - 1650) / 2200, 0, 1);

/** Real bathymetry to ~560 m: depth in meters at world (x,z). Pure, closed-form. */
export function depthAt(x: number, z: number): number {
  const dz = z - chainZ(x);
  let d: number;
  if (dz < 0) d = 1.4 + Math.min(-dz, 2600) / 2600 * 3.4; // Florida Bay
  else if (dz < 1300) d = 2.2 + Math.min(dz, 520) / 520 * 5.6; // Hawk Channel
  else if (dz < 1460) d = 7.8 - (dz - 1300) / 160 * 4.4; // Sombrero Reef crest
  else if (dz < 1650) d = 3.4 + (dz - 1460) / 190 * 42; // reef wall
  else d = 45.4 + (dz - 1650) * 0.14; // Gulf Stream
  if (dz < 1460) {
    const n = Math.sin(x * 0.0047 + 1.7) * Math.cos(z * 0.0056 - 0.4) + 0.5 * Math.sin(x * 0.011 + z * 0.0083) + 0.3 * Math.sin(x * 0.031 - z * 0.027);
    d += n * (dz < 0 ? 1.15 : 0.9);
  }
  for (const H of HUMPS) {
    const hd = Math.hypot(x - H.x, dz - H.dz);
    d = Math.min(d, H.patch ? 2.4 + hd * 0.03 : 40 + hd * 0.32);
  }
  if (Math.abs(dz) < 60) d = Math.max(d, 4.6 + (60 - Math.abs(dz)) / 60 * 2.4); // channels under US-1
  const sd = shoreInfo(x, z).d;
  if (sd < 70) { const t = Math.max(0, sd) / 70; d = Math.min(d, 0.35 + t * t * (d - 0.35)); }
  for (const C of CHANNELS) {
    if (x > C.x0 && x < C.x1 && dz > C.dz0 && dz < C.dz1 && sd > 2) d = Math.max(d, C.d);
  }
  for (const C of MIAMI_CH) {
    if (x > C.x0 && x < C.x1 && z > C.z0 && z < C.z1 && sd > 1) d = Math.max(d, C.d);
  }
  {
    const cd = creekDist(x, z);
    if (cd < 0) d = Math.max(d, 2.6 + Math.min(1.5, -cd * 0.1));
  }
  for (const M of MARINAS) {
    const r = (z - M.sz) * M.dir;
    if (Math.abs(x - M.sx) < 34 && r > -2 && r < 78) d = Math.max(d, 3.2);
  }
  {
    // The entrance channel out of that basin — see MARINA_CUT. Shoals off at the edges so the
    // bottom rises to meet the bank rather than ending in a wall.
    const mc = marinaCutDepth(x, z);
    if (mc > 0) d = Math.max(d, 0.35 + (MARINA_CUT.d - 0.35) * Math.min(1, mc / MARINA_CUT.feather));
  }
  return Math.max(0.3, d);
}

export interface OldBridge {
  x0: number;
  x1: number;
  dz: number;
  gap: [number, number];
}

export const OLDBR: OldBridge = { x0: -3820, x1: -2010, dz: -58, gap: [-3200, -3080] };

export function nearBridge(x: number, z: number): boolean {
  const dz = z - chainZ(x);
  if (x < WB.x0 || x > WB.x1) return false;
  return Math.abs(dz) < 38 || (x > OLDBR.x0 && x < OLDBR.x1 && Math.abs(dz - OLDBR.dz) < 30);
}

export function nearHump(x: number, z: number): Hump | null {
  const dz = z - chainZ(x);
  for (const H of HUMPS) {
    if (!H.patch && Math.hypot(x - H.x, dz - H.dz) < 420) return H;
  }
  return null;
}

export type Zone = 'Creek' | 'Bridge' | 'Flats' | 'Backcountry' | 'Offshore' | 'Reef' | 'Hawk Channel';

export function zoneAt(x: number, z: number): Zone {
  const d = depthAt(x, z), dz = z - chainZ(x);
  if (creekDist(x, z) < 0) return 'Creek';
  if (nearBridge(x, z) && d >= 2 && shoreInfo(x, z).d > 6) return 'Bridge';
  if (d < 2.6) return 'Flats';
  if (dz < 0) return 'Backcountry';
  if (d >= 45) return 'Offshore';
  if (dz > 1250) return 'Reef';
  return 'Hawk Channel';
}

export const ZONE_DESC: Record<string, string> = {
  'Oil Rig': 'Oil rig',
  Wreck: 'Shipwreck',
  Weedline: 'Weedline',
  Creek: 'Mangrove creek',
  Flats: 'Skinny-water flats',
  Backcountry: 'Florida Bay backcountry',
  Bridge: 'Bridge channel',
  'Hawk Channel': 'Hawk Channel',
  Reef: 'Sombrero Reef',
  Offshore: 'Gulf Stream',
};
