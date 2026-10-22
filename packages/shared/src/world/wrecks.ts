/**
 * Shipwrecks: where they lie, how they sit, and where the fish hold on them. Pure and three-free
 * (CI: check:no-three) so the same table drives the client's hulls, its minimap, the rod's
 * "Wreck" zone and, later, the server's cast resolution.
 *
 * **Placement is computed, never typed in.** Each wreck is a *spec* (what it is, the stretch of
 * bathymetry it belongs on, the depth band it has to sink into) and `wrecksFor(seed)` walks
 * `hashCell(seed, specIndex, attempt, salt)` candidates until one passes every test against the
 * real `depthAt`/`landH`/`shoreInfo`/`zoneAt`: open water, well off every island, not on a flat,
 * deep enough to sit a hull under (`height + CLEARANCE_M`), and a seabed that does not change by
 * more than `maxRelief` across the hull's footprint. The attempt index is the only loop variable,
 * so a spec's position is a pure function of (seed, its own index) - adding a wreck, or editing
 * another one, can never move this one (docs/ARCHITECTURE.md "Seeding"). A hand-typed coordinate is
 * one terrain tweak from a freighter in a mangrove; this is the same self-correcting idea as
 * `MARINAS` and the party-boat anchorages, and test/wrecks.test.ts asserts the *result*.
 *
 * **Attitude comes from the seabed too.** A hull settles along the contour (a ship that went down
 * on the reef wall lies parallel to it, not nose-first down the drop), pitches with the slope
 * under its own length, and heels to a per-wreck `list`. `heading` uses the sim's convention
 * (forward = (-sin h, -cos h), as in `sim/boat.ts`).
 *
 * Fish: `holdPoints` are the spots on a wreck where schools sit (bow, midships, stern, the
 * superstructure, the lee-side scour hole), as world x/z plus a height above the seabed. The
 * client turns each into a resident `SchoolAnchor` - the existing mechanism, not a new spawner.
 */
import { hashCell } from '../rng/index.js';
import { chainZ, shoreInfo } from './chain.js';
import { depthAt, landH, zoneAt, HUMPS, type Zone } from './depth.js';

export type WreckKind = 'plane' | 'barge' | 'tug' | 'freighter';

/** Water that must remain over the highest point of a wreck, metres: enough that a keel-down hull
 * (and the player's own 1 m draft) never touches it, so a wreck is something you dive on, not a
 * reef you run onto. */
export const CLEARANCE_M = 4;
/** Cast capture radius, metres, measured from the hull's *edge* (`wreckEdgeDist`): a wreck is
 * 20-120 m long and a cast is a 12-85 m lob with no aiming aid. Rigs use 60 from a 30 m deck. */
export const WRECK_CAST_M = 28;
/** Distance within which a wreck becomes charted, metres - see entities/life/wrecks.ts for why
 * wrecks are found rather than given. */
export const WRECK_CHART_M = 260;

export interface WreckSpec {
  id: string;
  name: string;
  kind: WreckKind;
  /** Overall length and beam (m; for a plane, `beam` is the wingspan); `height` is hull plus
   * structure above the seabed. */
  len: number;
  beam: number;
  height: number;
  /** Search window: along-chain x, and offset from `chainZ(x)` - a stretch of reef wall, channel
   * or Gulf Stream, not a coordinate. */
  xRange: readonly [number, number];
  dzRange: readonly [number, number];
  /** Required water depth at the hull's centre. */
  depth: readonly [number, number];
  /** Largest allowed seabed range across the footprint (m). Looser on the wall, where the hull is
   * laid along the contour and the drop is across it. */
  maxRelief: number;
  /** Heel, radians (+ = starboard down). */
  list: number;
  /** Snapped in two: the stern section is offset and yawed relative to the bow section. */
  broken: boolean;
  /** Fish this wreck holds: more hold points and schools for a bigger one (1 = a small wreck). */
  mass: number;
}

/** Hand-authored *what*; the *where* is found. Ordered shallow -> deep. The sizes are real: the
 * Keys' artificial reefs are 60-150 m steel freighters and cutters, plus the odd aircraft. Depth
 * bands follow docs/ARCHITECTURE.md: a plane and a barge in Hawk Channel for the snorkeller, a tug
 * on the reef-wall top, a listing freighter at the band-5 edge (spearable), a freighter broken in
 * two on the deep wall, and one big one out in the Gulf Stream that only the rod will ever reach. */
export const WRECK_SPECS: readonly WreckSpec[] = [
  { id: 'dc3', name: 'Twin-engine airliner', kind: 'plane', len: 20, beam: 29, height: 3, xRange: [800, 2400], dzRange: [450, 1150], depth: [7, 8.7], maxRelief: 1.6, list: 0.1, broken: true, mass: 0.7 },
  { id: 'barge', name: 'Sand barge', kind: 'barge', len: 46, beam: 11, height: 3, xRange: [-3500, -1900], dzRange: [450, 1150], depth: [7, 8.7], maxRelief: 1.6, list: 0.05, broken: false, mass: 0.8 },
  { id: 'tug', name: 'Harbor tug', kind: 'tug', len: 26, beam: 7.5, height: 7, xRange: [0, 700], dzRange: [1478, 1510], depth: [11.5, 15], maxRelief: 4, list: -0.32, broken: false, mass: 1 },
  { id: 'freighterA', name: 'Coastal freighter', kind: 'freighter', len: 84, beam: 13, height: 15, xRange: [1500, 3200], dzRange: [1510, 1545], depth: [19.5, 25], maxRelief: 7, list: 0.42, broken: false, mass: 2 },
  { id: 'freighterB', name: 'Cargo steamer', kind: 'freighter', len: 98, beam: 14, height: 16, xRange: [-3600, -2200], dzRange: [1585, 1612], depth: [34, 42], maxRelief: 9, list: -0.18, broken: true, mass: 2.4 },
  { id: 'freighterC', name: 'Deep-water freighter', kind: 'freighter', len: 120, beam: 17, height: 20, xRange: [-1500, -700], dzRange: [1700, 1900], depth: [52, 68], maxRelief: 6, list: 0.08, broken: true, mass: 3 },
];

export interface Wreck extends WreckSpec {
  index: number;
  x: number;
  z: number;
  /** Water depth at the centre (m); the seabed y is `-seaDepth` (1 world unit = 1 m). */
  seaDepth: number;
  /** Hull heading (radians, sim convention). */
  heading: number;
  /** Bow-down pitch (radians) from the seabed slope under the hull's length. */
  pitch: number;
  /** Which attempt of the spec's search produced this site (diagnostic, asserted bounded). */
  attempt: number;
  /** Stern section of a `broken` wreck: `gap` metres further aft along the hull axis and yawed
   * `breakYaw` relative to the bow section; 0/0 when intact. */
  gap: number;
  breakYaw: number;
}

const SALT_X = 9811, SALT_DZ = 9812, SALT_HDG = 9813, SALT_GAP = 9814, SALT_YAW = 9815;
const MAX_ATTEMPTS = 4000;
/** Keep a wreck this far from any shoreline (m): "open water", not a lee shore. */
const MIN_SHORE_M = 300;
/** ... and this far from the named humps, whose `depthAt` cap would shallow the footprint. */
const MIN_HUMP_M = 320;

const fwd = (h: number): [number, number] => [-Math.sin(h), -Math.cos(h)];

/** Footprint sample points: a 5 x 3 grid over the hull's length and beam. */
function footprint(x: number, z: number, h: number, len: number, beam: number): Array<[number, number]> {
  const [fx, fz] = fwd(h), rx = -fz, rz = fx;
  const out: Array<[number, number]> = [];
  for (const u of [-0.5, -0.25, 0, 0.25, 0.5]) {
    for (const v of [-0.5, 0, 0.5]) out.push([x + fx * len * u + rx * beam * v, z + fz * len * u + rz * beam * v]);
  }
  return out;
}

/** Heading (sim convention) of the local contour: perpendicular to the seabed gradient, taken by
 * central difference on the real depth. */
function contourHeading(x: number, z: number): number {
  const e = 12;
  const gx = (depthAt(x + e, z) - depthAt(x - e, z)) / (2 * e), gz = (depthAt(x, z + e) - depthAt(x, z - e)) / (2 * e);
  return Math.atan2(gz, -gx); // forward = (-gz, gx) => h = atan2(-fx, -fz)
}

function humpDist(x: number, z: number): number {
  const dz = z - chainZ(x);
  let best = Infinity;
  for (const H of HUMPS) best = Math.min(best, Math.hypot(x - H.x, dz - H.dz));
  return best;
}

const ALLOWED_ZONES: ReadonlySet<Zone> = new Set<Zone>(['Hawk Channel', 'Reef', 'Offshore']);

/** One candidate position for spec `i` at attempt `k`: null if it fails any real-world test. */
function tryPlace(seed: number, spec: WreckSpec, i: number, k: number): Wreck | null {
  const x = spec.xRange[0] + (spec.xRange[1] - spec.xRange[0]) * hashCell(seed, i, k, SALT_X);
  const dz = spec.dzRange[0] + (spec.dzRange[1] - spec.dzRange[0]) * hashCell(seed, i, k, SALT_DZ);
  const z = chainZ(x) + dz;
  if (landH(x, z) > -0.3) return null;
  const d = depthAt(x, z);
  if (d < spec.depth[0] || d > spec.depth[1] || d < spec.height + CLEARANCE_M) return null;
  if (!ALLOWED_ZONES.has(zoneAt(x, z))) return null;
  if (shoreInfo(x, z).d < MIN_SHORE_M || humpDist(x, z) < MIN_HUMP_M) return null;
  // Laid along the contour, with a wobble (a ship that sank under way is rarely dead parallel),
  // bow either way.
  const heading = contourHeading(x, z) + (hashCell(seed, i, k, SALT_HDG) - 0.5) * 0.5 + (hashCell(seed, i, k, SALT_HDG + 50) < 0.5 ? 0 : Math.PI);
  let lo = Infinity, hi = -Infinity;
  for (const [px, pz] of footprint(x, z, heading, spec.len, spec.beam)) {
    if (landH(px, pz) > -0.3) return null;
    const pd = depthAt(px, pz);
    lo = Math.min(lo, pd); hi = Math.max(hi, pd);
  }
  if (hi - lo > spec.maxRelief) return null;
  // The shallowest corner still has to clear the hull top.
  if (lo < spec.height + CLEARANCE_M * 0.5) return null;
  const [fx, fz] = fwd(heading);
  const pitch = Math.atan2(depthAt(x + fx * spec.len * 0.4, z + fz * spec.len * 0.4) - depthAt(x - fx * spec.len * 0.4, z - fz * spec.len * 0.4), spec.len * 0.8);
  const gap = spec.broken ? spec.len * (0.12 + 0.12 * hashCell(seed, i, k, SALT_GAP)) : 0;
  const breakYaw = spec.broken ? (hashCell(seed, i, k, SALT_YAW) - 0.5) * 0.9 : 0;
  return { ...spec, index: i, x, z, seaDepth: d, heading, pitch, attempt: k, gap, breakYaw };
}

const _cache = new Map<number, readonly Wreck[]>();

/** Every wreck for a world seed. A spec that finds no site is simply absent (a terrain change
 * costs a wreck, it never puts one somewhere wrong); test/wrecks.test.ts asserts none are lost. */
export function wrecksFor(seed: number): readonly Wreck[] {
  const hit = _cache.get(seed);
  if (hit) return hit;
  const out: Wreck[] = [];
  WRECK_SPECS.forEach((spec, i) => {
    for (let k = 0; k < MAX_ATTEMPTS; k++) {
      const w = tryPlace(seed, spec, i, k);
      if (w) { out.push(w); break; }
    }
  });
  _cache.set(seed, out);
  return out;
}

/** World position of a point along a wreck's axis (`u` in hull lengths, -0.5 stern..0.5 bow; `v`
 * in beams to starboard). Aft of the snap the stern section is offset and yawed. */
export function wreckPoint(w: Wreck, u: number, v = 0): { x: number; z: number } {
  const [fx, fz] = fwd(w.heading), rx = -fz, rz = fx;
  let a = u * w.len, side = v * w.beam;
  if (w.broken && u < 0) {
    const c = Math.cos(w.breakYaw), s = Math.sin(w.breakYaw);
    const along = a, lat = side;
    a = along * c - lat * s - w.gap; side = along * s + lat * c;
  }
  return { x: w.x + fx * a + rx * side, z: w.z + fz * a + rz * side };
}

/** Distance (m) from (x,z) to the wreck's hull, ~0 on it. Uses the axis segment (bow to the far
 * end of the stern section) widened by half the beam. */
export function wreckEdgeDist(w: Wreck, x: number, z: number): number {
  const [fx, fz] = fwd(w.heading);
  const dx = x - w.x, dz = z - w.z;
  const along = Math.max(-w.len / 2 - w.gap, Math.min(w.len / 2, dx * fx + dz * fz));
  const px = w.x + fx * along, pz = w.z + fz * along;
  return Math.max(0, Math.hypot(x - px, z - pz) - w.beam / 2);
}

/** The wreck a cast landing at (x,z) is "on", if any: within `r` of the hull's edge. */
export function wreckNear(seed: number, x: number, z: number, r = WRECK_CAST_M): Wreck | null {
  let best: Wreck | null = null, bd = r;
  for (const w of wrecksFor(seed)) {
    const d = wreckEdgeDist(w, x, z);
    if (d < bd) { bd = d; best = w; }
  }
  return best;
}

export interface HoldPoint {
  x: number;
  z: number;
  /** Height above the seabed of the school's centre (m) and its vertical spread. */
  h: number;
  hr: number;
  /** Tether radius of the school's patch (m). */
  r: number;
  label: 'bow' | 'midships' | 'stern' | 'house' | 'lee';
}

/** Where schools sit on a wreck. Heights are fractions of the hull height so a tug and a
 * freighter scale alike: pelagic hunters hold up in the water over the structure, groupers low in
 * the shadow of the lee side. Bigger wrecks (`mass`) get more points, hence more schools. */
export function holdPoints(w: Wreck): HoldPoint[] {
  const H = w.height;
  const pts: HoldPoint[] = [];
  const at = (u: number, v: number, hf: number, r: number, label: HoldPoint['label']): void => {
    const p = wreckPoint(w, u, v);
    const hr = Math.max(1, H * 0.15);
    // Never above the water: a school centred where the top of its spread would break the surface
    // is clamped down (the stern of a 15 m hull in 21 m of water is the case that bites).
    pts.push({ x: p.x, z: p.z, h: Math.max(hr + 0.5, Math.min(H * hf, w.seaDepth - 1.5 - hr)), hr, r, label });
  };
  const rb = Math.max(3.5, w.beam * 0.55), lr = Math.max(3, w.beam * 0.3);
  // Heights clear the deck and the deckhouse (the stern carries it on a freighter/tug) so a
  // school never sits inside steel; `lee` points are beside the hull and take the bottom-holders.
  at(0.38, 0, 0.95, rb + 2, 'bow');
  at(0, 0, 1.1, rb + 4, 'midships');
  at(-0.38, 0, 1.25, rb + 2, 'stern');
  at(0, 0.95, 0.3, lr, 'lee');
  if (w.mass >= 1.5) at(0.1, 0, 1.5, rb + 3, 'house');
  if (w.mass >= 2.2) at(-0.2, -0.95, 0.4, lr, 'lee');
  return pts;
}

/**
 * What a wreck holds, as `VIS`/`SPECIES` keys with weights: the underwater counterpart of the
 * rod's 'Wreck' `ZONE_TABLE` entry. Same species, same lean to big structure-holders (no
 * baitfish clouds: this is the "where the big ones are" table), filtered per wreck by what can
 * live at its depth. Weighted by the same ideas as the rod table so a diver sees what a cast
 * promises.
 */
export const WRECK_RESIDENTS: ReadonlyArray<readonly [string, number]> = [
  ['amberjack', 5], ['goliath', 2.4], ['grouper', 2.6], ['gag', 1.6], ['cobia', 2.4], ['barracuda', 2],
  ['jackcrevalle', 2.4], ['bullshark', 0.9], ['kingfish', 1.2], ['mutton', 1], ['blacktip', 0.5],
];
