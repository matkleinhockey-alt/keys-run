/**
 * Keys Run Estates: shore lots you buy with the game's cash, then build on — a residence, a dock,
 * your biggest catch hung up for everyone to see, trophies round the grounds. Whoever holds #1 on
 * the leaderboard throws the party at their best house.
 *
 * Pure rules and geometry only. The plat (every parcel's polygon) is data in ./estates-plat.ts;
 * the registry of who owns what is apps/api/src/routes/estates.ts (signed in) or the client's
 * localStorage (offline), the same split as tag-and-release; the meshes are
 * apps/client/src/entities/estates. Everything that decides WHERE something stands on a lot —
 * the house, the dock, the gallows — is computed here by `siteLayout`, so the walk surface
 * (`estateGround`) and what is drawn can never disagree.
 *
 * ⚠ Paid for from a client-side wallet (apps/client/src/game/economy/system.ts says why that is
 * accepted for now). The server records ownership and refuses a lot that is already taken, but it
 * cannot check the buyer could afford it until the wallet moves server-side.
 */
import { SPECIES } from './species.js';
import { islandDist, islands, shoreInfo, type Island } from '../world/chain.js';
import { landH } from '../world/depth.js';
import { COLLIDERS, PAD_Y, TOWN_FRAME } from '../world/town.js';
import { PARCELS } from './estates-plat.js';

export { PARCELS };

export type Tier = 'harbor' | 'private' | 'point' | 'oceanfront' | 'bayfront' | 'biscayne' | 'mainland';

export interface Parcel {
  id: string;
  name: string;
  island: string;
  tier: Tier;
  side: string;
  /** Centroid, world metres; the lot's most inland spot instead where its centroid falls off it
   * (a lot wrapped round a canal). Always on the lot's dry ground. */
  cx: number; cz: number;
  /** m² of game ground. */
  area: number;
  /** Metres of shore (a private island's whole shoreline). */
  frontage: number;
  /** On the town pad: walkable without an estate surface. */
  walkable?: boolean;
  poly: ReadonlyArray<readonly [number, number]>;
}

/* ------------------------------------------------------------------ tiers & pricing */

export const TIERS: Readonly<Record<Tier, { label: string; base: number; blurb: string }>> = {
  harbor:     { label: 'Harbor Row',        base: 60000,  blurb: 'Town lots behind the casino, on the pad you can already walk.' },
  private:    { label: 'Private Island',    base: 120000, blurb: 'A whole key. Every shore is yours, and no neighbour can see in.' },
  point:      { label: 'Point Estate',      base: 45000,  blurb: 'The tip of an island, with water on three sides.' },
  oceanfront: { label: 'Oceanfront Estate', base: 30000,  blurb: 'Hawk Channel side. Faces Sombrero Reef and the Gulf Stream run.' },
  bayfront:   { label: 'Bayfront Estate',   base: 22000,  blurb: 'Florida Bay side. Sunsets over the backcountry flats.' },
  biscayne:   { label: 'Biscayne Estate',   base: 18000,  blurb: 'Key Biscayne, looking across the bay at the Miami skyline.' },
  mainland:   { label: 'Mainland Bayfront', base: 6000,   blurb: 'Mainland shore west of the city, on Biscayne Bay.' },
};
export const TIER_ORDER: readonly Tier[] = ['harbor', 'private', 'point', 'oceanfront', 'bayfront', 'biscayne', 'mainland'];

const MEDIAN_AREA: Record<string, number> = {};
for (const t of TIER_ORDER) {
  const a = PARCELS.filter((p) => p.tier === t).map((p) => p.area).sort((x, y) => x - y);
  MEDIAN_AREA[t] = a[a.length >> 1] || 1;
}

/** One base price per tier, scaled by √(area / the tier's median area), to the nearest $500. */
export function priceOf(p: Parcel): number {
  return Math.round(TIERS[p.tier].base * Math.sqrt(p.area / MEDIAN_AREA[p.tier]) / 500) * 500;
}

const BY_ID = new Map(PARCELS.map((p) => [p.id, p]));
export function parcelById(id: string): Parcel | undefined { return BY_ID.get(id); }

/* ------------------------------------------------------------------ founding holders */

/**
 * Lots held back for the founders, by display name (unique, case-insensitive, in apps/api's users
 * table). Never for sale; whoever is signed in under that name may build on them. Placeholders
 * from the plat review — swap them if other lots were promised.
 */
export const FOUNDING_HOLDERS: Readonly<Record<string, string>> = {
  'pigeon-key': 'Klein', 'harbor-row-1': 'Klein',
  'fisher-island': 'Larry', 'harbor-row-4': 'Larry',
};

/* ------------------------------------------------------------------ build options */

export const RESIDENCES = {
  villa:  { label: 'Villa',           note: 'Two storeys, pool deck',            w: 34, d: 22 },
  shack:  { label: 'Fishing shack',   note: 'Tin roof, porch, cooler',           w: 9,  d: 7 },
  garden: { label: 'Japanese garden', note: 'Tea house, koi pond, raked gravel', w: 14, d: 10 },
  stilt:  { label: 'Stilt house',     note: 'On pilings at the waterline',       w: 16, d: 12 },
  glass:  { label: 'Modern glass',    note: 'Flat roof, infinity edge',          w: 30, d: 15 },
} as const;
export type ResidenceKey = keyof typeof RESIDENCES;

export const DOCKS = {
  none:  { label: 'No dock',           note: 'Beach landing',        len: 0,  w: 0 },
  skiff: { label: 'Skiff dock',        note: '12 m, flats boat',     len: 12, w: 2.4 },
  sport: { label: 'Sportfish slip',    note: '30 m, fighting chair', len: 30, w: 3 },
  yacht: { label: 'Superyacht T-head', note: '60 m, helipad',        len: 60, w: 6 },
} as const;
export type DockKey = keyof typeof DOCKS;

export const MOUNTS = { door: 'Over the front door', gallows: 'Dock weigh-station gallows', pedestal: 'Garden pedestal' } as const;
export type MountKey = keyof typeof MOUNTS;

export const MAX_TROPHIES = 10;

export interface Build {
  res: ResidenceKey;
  dock: DockKey;
  /** The fish hung on the property: species key and weight. */
  fish: string;
  lb: number;
  mount: MountKey;
  trophies: number;
  pool: boolean;
  firepit: boolean;
}

const PRESETS: Readonly<Record<string, Partial<Build>>> = {
  'pigeon-key':    { res: 'garden', dock: 'sport', fish: 'marlin', lb: 742, mount: 'gallows', trophies: 6, pool: false, firepit: true },
  'fisher-island': { res: 'villa', dock: 'yacht', fish: 'bluefin', lb: 688, mount: 'door', trophies: 4, pool: true, firepit: false },
};

export function defaultBuild(p: Parcel): Build {
  const harbor = p.tier === 'harbor';
  return {
    res: harbor ? 'glass' : 'villa', dock: harbor ? 'none' : 'sport', fish: 'marlin', lb: 512,
    mount: harbor ? 'door' : 'gallows', trophies: 3, pool: true, firepit: false, ...PRESETS[p.id],
  };
}

const has = <T extends object>(o: T, k: unknown): k is keyof T => typeof k === 'string' && Object.hasOwn(o, k);

/** Whatever arrived (a request body, old localStorage) → a valid build for this lot. */
export function sanitizeBuild(raw: unknown, p: Parcel): Build {
  const d = defaultBuild(p);
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fish = has(SPECIES, r.fish) ? r.fish : d.fish;
  const max = SPECIES[fish].max;
  const lb = typeof r.lb === 'number' && Number.isFinite(r.lb) ? Math.min(max, Math.max(1, Math.round(r.lb * 10) / 10)) : Math.min(max, d.lb);
  const dock = has(DOCKS, r.dock) ? r.dock : d.dock;
  let mount = has(MOUNTS, r.mount) ? r.mount : d.mount;
  // Harbor Row lots are town pad, not shore: no dock to build, so no gallows to hang from it.
  if (p.tier === 'harbor' || dock === 'none') { if (mount === 'gallows') mount = 'door'; }
  return {
    res: has(RESIDENCES, r.res) ? r.res : d.res,
    dock: p.tier === 'harbor' ? 'none' : dock,
    fish, lb, mount,
    trophies: typeof r.trophies === 'number' && Number.isFinite(r.trophies) ? Math.min(MAX_TROPHIES, Math.max(0, Math.round(r.trophies))) : d.trophies,
    pool: typeof r.pool === 'boolean' ? r.pool : d.pool,
    firepit: typeof r.firepit === 'boolean' ? r.firepit : d.firepit,
  };
}

/* ------------------------------------------------------------------ geometry */

export function pointInPoly(poly: Parcel['poly'], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** 200 m buckets of parcel bounding boxes, so `parcelAt` tests a handful of polygons, not 282. */
const CELL = 200;
const GRID = new Map<string, Parcel[]>();
const BOX = new Map<string, [number, number, number, number]>();
for (const p of PARCELS) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of p.poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  BOX.set(p.id, [x0, x1, z0, z1]);
  for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) {
    for (let k = Math.floor(z0 / CELL); k <= Math.floor(z1 / CELL); k++) {
      const key = i + ',' + k;
      const list = GRID.get(key);
      if (list) list.push(p); else GRID.set(key, [p]);
    }
  }
}

/** The parcel whose ground (x, z) is on, if any. */
export function parcelAt(x: number, z: number): Parcel | null {
  for (const p of GRID.get(Math.floor(x / CELL) + ',' + Math.floor(z / CELL)) ?? []) {
    const [x0, x1, z0, z1] = BOX.get(p.id)!;
    if (x >= x0 && x <= x1 && z >= z0 && z <= z1 && pointInPoly(p.poly, x, z)) return p;
  }
  return null;
}

/** The island a lot is on. Names are not unique (the four Venetian Islands share one), and a
 * lot's `island` may be its own display name, so ties and misses go to the nearest island. */
function islandOf(p: Parcel): Island | null {
  const named = islands.filter((I) => I.name === p.island);
  if (named.length === 1) return named[0];
  if (!named.length) return shoreInfo(p.cx, p.cz).isl;
  let best = named[0], bd = Infinity;
  for (const I of named) { const d = islandDist(I, p.cx, p.cz); if (d < bd) { bd = d; best = I; } }
  return best;
}

/** Unit vector at (x, z) toward island I's nearest shore: the gradient of its signed distance,
 * by central differences. null where that is flat (past COAST_CAP inland, or a medial axis). */
function outward(I: Island, x: number, z: number, h = 2): [number, number] | null {
  const gx = islandDist(I, x + h, z) - islandDist(I, x - h, z), gz = islandDist(I, x, z + h) - islandDist(I, x, z - h);
  const n = Math.hypot(gx, gz);
  return n < 1e-6 ? null : [gx / n, gz / n];
}

/** Unit vector from the lot toward open water: the way its island's real shoreline is nearest from
 * the lot (on a long key like Vaca, "away from the centre" would point down the key's length).
 * Deep inland, where the distance field is flat, away from the island's centre; failing that +z,
 * the way the mainland faces the bay. Harbor Row faces the harbour like the rest of town. */
export function seaward(p: Parcel): [number, number] {
  if (p.tier === 'harbor') return [0, TOWN_FRAME.dir];
  const I = islandOf(p);
  if (!I) return [0, 1];
  const g = outward(I, p.cx, p.cz);
  if (g) return g;
  const dx = p.cx - I.x, dz = p.cz - I.z, n = Math.hypot(dx, dz);
  return n > 1e-6 ? [dx / n, dz / n] : [0, 1];
}

/** How far a dock may run looking for water and room. */
const DOCK_REACH = DOCKS.yacht.len + 30;

/** Water along a ray: `wet[t]` for t = 0..DOCK_REACH m. */
function wetRay(x: number, z: number, sx: number, sz: number): boolean[] {
  const wet: boolean[] = [];
  for (let t = 0; t <= DOCK_REACH; t++) wet.push(landH(x + sx * t, z + sz * t) <= 0);
  return wet;
}

interface DockSite { x: number; z: number; sx: number; sz: number; wet: boolean[] }
const SITES = new Map<string, DockSite>();

/**
 * Where a lot meets the water, and which way its dock runs: a point on the lot's edge and the
 * outward normal of the real shore there. Real shores are cut by canals, so every edge vertex is
 * tried and scored: water close in, a long clear run of it (open water beats a canal that ends at
 * the neighbour's seawall), and facing roughly `seaward`. Fixed per lot, so it is worked out once.
 */
function dockSite(p: Parcel): DockSite {
  const hit = SITES.get(p.id);
  if (hit) return hit;
  const pref = seaward(p);
  const I = islandOf(p);
  const step = Math.max(1, Math.floor(p.poly.length / 48));
  let best: DockSite | null = null, bs = -Infinity;
  for (let i = 0; i < p.poly.length; i += step) {
    const [x, z] = p.poly[i];
    const [sx, sz] = (I && outward(I, x, z)) || pref;
    const wet = wetRay(x, z, sx, sz);
    const first = wet.indexOf(true);
    if (first < 0 || first > 14) continue;
    let run = 0;
    while (first + run < wet.length && wet[first + run]) run++;
    const score = Math.min(run, DOCKS.yacht.len + 10) - 3 * first + 15 * (sx * pref[0] + sz * pref[1])
      // and prefer the lot's seaward side to a back corner
      + 0.1 * ((x - p.cx) * pref[0] + (z - p.cz) * pref[1]);
    if (score > bs) { bs = score; best = { x, z, sx, sz, wet }; }
  }
  if (!best) {
    // nothing on the edge sees water within reach: run from the edge vertex furthest seaward
    let v = p.poly[0], far = -Infinity;
    for (const w of p.poly) { const d = (w[0] - p.cx) * pref[0] + (w[1] - p.cz) * pref[1]; if (d > far) { far = d; v = w; } }
    best = { x: v[0], z: v[1], sx: pref[0], sz: pref[1], wet: wetRay(v[0], v[1], pref[0], pref[1]) };
  }
  SITES.set(p.id, best);
  return best;
}

/** How long a dock of nominal length `want` is off this site: as near `want` as it can be while
 * ending in water, carried on past a wide beach, and stopping 4 m short of the next land it would
 * run into (a lot facing a near neighbour across a canal or a narrow cut). */
function dockLen(site: DockSite, want: number): number {
  const { wet } = site;
  const first = wet.indexOf(true);
  if (first < 0) return want;
  let land = first;
  while (land < wet.length && wet[land]) land++;
  const hi = land < wet.length ? land - 4 : wet.length - 1;
  let best = -1, bd = Infinity;
  for (let t = Math.max(1, first + 3); t <= hi; t++) {
    if (!wet[t] || Math.abs(t - want) >= bd) continue;
    bd = Math.abs(t - want); best = t;
  }
  // a cut too narrow for the 3 m margins: the middle of the water
  return best >= 0 ? best : Math.floor((first + land - 1) / 2);
}

/** Top of an estate dock's planks: the same height as a marina deck, so the boat code's tie-up
 * height is right at both. */
export const ESTATE_DOCK_TOP = 1.425;
/** The dock's landward end runs this far up the lot as a ramp from the ground to the planks. */
export const DOCK_RAMP = 8;

export interface SiteLayout {
  /** Facing seaward: `heading` is atan2(sx, sz), the yaw a +z-facing model turns by. */
  heading: number;
  sea: [number, number];
  house: { x: number; z: number; w: number; d: number; y: number };
  /** Plank strip from the shore (x0,z0) to the end (x1,z1); the ramp is the landward DOCK_RAMP m. */
  dock: { x0: number; z0: number; x1: number; z1: number; w: number; len: number; tHead: number } | null;
  /** Where the hung fish hangs. */
  mount: { x: number; z: number };
  pool: { x: number; z: number } | null;
  firepit: { x: number; z: number } | null;
  /** Trophy plinth spots round the grounds, `build.trophies` of them, each on dry lot ground. */
  trophies: Array<{ x: number; z: number }>;
}

function clearOfTown(x: number, z: number, r: number): boolean {
  for (const c of COLLIDERS) if (x + r > c.x0 && x - r < c.x1 && z + r > c.z0 && z - r < c.z1) return false;
  return true;
}

function dryGround(p: Parcel, x: number, z: number): boolean {
  return pointInPoly(p.poly, x, z) && (p.tier === 'harbor' ? clearOfTown(x, z, 1) : landH(x, z) > 0.3);
}

/**
 * Harbor Row lots run back to the lane where town cars park (and a boat trailer noses over one
 * lot's edge), so the house is fitted into the lot's clear part: 2.5 m in from the sides, 1 m
 * short of the first parked car, shrunk if the chosen residence is wider than that.
 */
function harborHouse(p: Parcel, w: number, d: number): { x: number; z: number; w: number; d: number } {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of p.poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const mid = (z0 + z1) / 2;
  let front = z1 - 1;
  for (const c of COLLIDERS) if (c.x1 > x0 && c.x0 < x1 && c.z0 > mid && c.z0 < z1) front = Math.min(front, c.z0 - 1);
  const W = Math.min(w, x1 - x0 - 5), D = Math.min(d, front - z0 - 3);
  return { x: (x0 + x1) / 2, z: front - D / 2 - 2, w: W, d: D };
}

/**
 * Where everything on a lot stands. The shore point and the way the dock runs are `dockSite`'s;
 * the house sits between the centroid and the shore (a stilt house right at the water), facing
 * the same way, and the dock runs straight out from the shore point.
 */
export function siteLayout(p: Parcel, b: Build): SiteLayout {
  const harbor = p.tier === 'harbor';
  const site = harbor ? null : dockSite(p);
  const [sx, sz] = site ? [site.sx, site.sz] : seaward(p);
  const shore: readonly [number, number] = site ? [site.x, site.z] : p.poly[0];
  const RES = RESIDENCES[b.res];
  const R = { w: RES.w as number, d: RES.d as number };
  const t = b.res === 'stilt' ? 0.75 : 0.2;
  let hx = p.cx + (shore[0] - p.cx) * t, hz = p.cz + (shore[1] - p.cz) * t;
  if (harbor) { const h = harborHouse(p, R.w, R.d); hx = h.x; hz = h.z; R.w = h.w; R.d = h.d; }
  // Small or odd-shaped lots: walk the house back toward the centroid until it is on dry ground
  // (the plat keeps every lot's (cx, cz) on dry ground well inside it).
  for (let i = 0; i < 6 && !dryGround(p, hx, hz); i++) { hx = (hx + p.cx) / 2; hz = (hz + p.cz) / 2; }
  if (!dryGround(p, hx, hz)) { hx = p.cx; hz = p.cz; }
  const hy = harbor ? PAD_Y : Math.max(0.3, landH(hx, hz));
  // across-shore unit vector
  const ax = -sz, az = sx;
  const D = DOCKS[b.dock];
  const len = site && D.len ? dockLen(site, D.len) : 0;
  const dock = site && D.len
    ? { x0: shore[0] - sx * DOCK_RAMP, z0: shore[1] - sz * DOCK_RAMP, x1: shore[0] + sx * len, z1: shore[1] + sz * len, w: D.w, len: len + DOCK_RAMP, tHead: b.dock === 'yacht' && len >= 30 ? 26 : 0 }
    : null;
  const front = (k: number) => [hx + sx * (R.d / 2 + k), hz + sz * (R.d / 2 + k)] as [number, number];
  const mount = b.mount === 'gallows' && dock
    ? { x: shore[0] + sx * 3 + ax * (D.w / 2 + 1.2), z: shore[1] + sz * 3 + az * (D.w / 2 + 1.2) }
    : b.mount === 'pedestal'
      ? (() => { const [x, z] = front(6); return { x: x + ax * (R.w / 2 + 2), z: z + az * (R.w / 2 + 2) }; })()
      : (() => { const [x, z] = front(0.3); return { x, z }; })();
  // In front of the house if there is lot there, else behind it (Harbor Row's front is the lane).
  const side = (k: number, f: number) => {
    for (const ff of [f, -R.d - f]) { const [x, z] = front(ff); const q = { x: x + ax * k, z: z + az * k }; if (dryGround(p, q.x, q.z)) return q; }
    const [x, z] = front(f); return { x: x + ax * k, z: z + az * k };
  };
  const pool = b.pool ? side(-R.w / 4, 6) : null;
  const firepit = b.firepit ? side(R.w / 2 + 4, 3) : null;
  const trophies: Array<{ x: number; z: number }> = [];
  for (let i = 0; trophies.length < b.trophies && i < 60; i++) {
    // a ring round the house, widening each lap
    const a = i * 2.39996, r = Math.max(R.w, R.d) * 0.75 + 4 + Math.floor(i / 10) * 3;
    const x = hx + Math.cos(a) * r, z = hz + Math.sin(a) * r;
    if (dryGround(p, x, z)) trophies.push({ x, z });
  }
  return { heading: Math.atan2(sx, sz), sea: [sx, sz], house: { x: hx, z: hz, w: R.w, d: R.d, y: hy }, dock, mount, pool, firepit, trophies };
}

/**
 * What you stand on at (x, z) on a lot you are allowed onto: the dock planks (with the ramp up to
 * them), else the lot's own dry ground. null off the lot or in the water, so the walker refuses
 * the step exactly as it does at the edge of the town pad. Harbor Row lots return null: the town
 * pad's own `groundAt` already covers them.
 */
export function estateGround(p: Parcel, layout: SiteLayout, x: number, z: number): number | null {
  if (p.tier === 'harbor') return null;
  const d = layout.dock;
  if (d) {
    const [sx, sz] = layout.sea;
    const along = (x - d.x0) * sx + (z - d.z0) * sz;
    const across = Math.abs((x - d.x0) * -sz + (z - d.z0) * sx);
    const onStrip = along >= -1e-6 && along <= d.len + 1e-6 && across <= d.w / 2 + 1e-6;
    const onHead = d.tHead > 0 && along >= d.len - 5 && along <= d.len && across <= d.tHead / 2;
    if (onStrip || onHead) {
      if (along >= DOCK_RAMP) return ESTATE_DOCK_TOP;
      const g = Math.max(0.3, landH(d.x0, d.z0));
      return g + (ESTATE_DOCK_TOP - g) * (along / DOCK_RAMP);
    }
  }
  if (!pointInPoly(p.poly, x, z)) return null;
  const h = landH(x, z);
  return h > 0.3 ? h : null;
}

/** Where a boat ties up at an estate dock: alongside the outer end, 0.45 m in from the plank edge
 * (the same inset as `findBerth`). */
export function estateBerth(layout: SiteLayout): { x: number; z: number } | null {
  const d = layout.dock;
  if (!d) return null;
  const [sx, sz] = layout.sea;
  const back = d.tHead ? 7 : 2;
  return { x: d.x1 - sx * back, z: d.z1 - sz * back };
}

/**
 * Tying up at an estate dock: the point on the dock's outer planks nearest a boat at (x, z),
 * pulled 0.45 m in from the edge (the same inset as town.ts's `findBerth`), or null if the boat is
 * more than `reach` from the dock. Only the decked part counts, never the ramp up from the beach.
 */
export function estateDockBerth(layout: SiteLayout, x: number, z: number, reach: number): { x: number; z: number; dist: number } | null {
  const d = layout.dock;
  if (!d) return null;
  const [sx, sz] = layout.sea;
  const ax = -sz, az = sx;
  const rx = x - d.x0, rz = z - d.z0;
  const along = Math.min(d.len - 0.45, Math.max(DOCK_RAMP + 1, rx * sx + rz * sz));
  const half = (d.tHead && along >= d.len - 5 ? d.tHead : d.w) / 2;
  const across = Math.min(half - 0.45, Math.max(-(half - 0.45), rx * ax + rz * az));
  const px = d.x0 + sx * along + ax * across, pz = d.z0 + sz * along + az * across;
  // distance to the plank's edge, not to the inset point
  const ex = d.x0 + sx * along + ax * Math.min(half, Math.max(-half, rx * ax + rz * az));
  const ez = d.z0 + sz * along + az * Math.min(half, Math.max(-half, rx * ax + rz * az));
  const dist = Math.hypot(x - ex, z - ez);
  return dist <= reach ? { x: px, z: pz, dist } : null;
}

/* ------------------------------------------------------------------ the party */

/** The lot the #1 angler's party is at: their most valuable one. */
export function partyLot(ownedIds: readonly string[]): Parcel | null {
  let best: Parcel | null = null;
  for (const id of ownedIds) {
    const p = BY_ID.get(id);
    if (p && (!best || priceOf(p) > priceOf(best))) best = p;
  }
  return best;
}

/* ------------------------------------------------------------------ the registry */

/** How many lots one angler may hold (founding lots don't count): keeps one rich wallet from
 * buying up a whole tier on day one. */
export const MAX_LOTS_PER_PLAYER = 3;

/** One owned lot, as the registry (server or offline) reports it. */
export interface Estate {
  parcelId: string;
  ownerName: string;
  /** Held by a founder rather than bought. */
  founding: boolean;
  build: Build;
  /** ISO time; null for a founding lot nobody has built on yet. */
  boughtAt: string | null;
}

/** Who is #1 on the leaderboard and which of their lots is throwing the party. */
export interface Party {
  parcelId: string;
  displayName: string;
  speciesKey: string;
  weightLb: number;
}

export interface Registry { estates: Estate[]; party: Party | null }
