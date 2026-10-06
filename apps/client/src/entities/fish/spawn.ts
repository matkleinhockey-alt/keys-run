/**
 * Deterministic spawning — replaces legacy `trySpawn`/`managePopulation` (index.html:2487-2537).
 *
 * docs/ARCHITECTURE.md's complaint about the legacy version is specific: `managePopulation`
 * ring-spawns around *the local boat* with `Math.random()` and frees fish beyond `POP_R+40`. In
 * a shared world that means two players at Sombrero Reef see different fish, and turning around
 * re-rolls the reef. The fix has two parts, matching the doc's "Resident schools" section:
 *
 *  - **Resident schools** (`residentsForChunk`): one deterministic roll per 64 m world chunk,
 *    pure function of `(seed, cx, cz)` — same species, same count, same member layout, every
 *    time, on every machine, forever. No "spawn" event exists for these at all; a chunk's
 *    resident is *computed*, not created, whenever it enters range, and discarded (not freed to
 *    a dormant list — there is nothing to preserve, recomputing is free and exact) when it
 *    leaves. This is this module's vitest-covered piece (test/fish-spawn.test.ts).
 *  - **Roaming schools** (`manageRoamers`): a smaller, simulated layer on top for the pelagic/
 *    wide-ranging species that don't belong to one patch reef (tuna, mahi, billfish — exactly
 *    `ZONE_LIFE['Offshore']`, plus whatever a resident roll didn't claim elsewhere). Candidate
 *    *cells* (not iteration order) decide whether/what spawns via `hashCell`, so the same cell
 *    offers the same species at the same density no matter when or in what order it's visited —
 *    but because roamers wander (`stepSchool` moves them), legacy's actual complaint ("turning
 *    around re-rolls the reef") is fixed by the **dormant list** below: a roamer that leaves
 *    render range is frozen, not deleted, and reappears exactly as it was for
 *    `DORMANT_TTL_S` seconds before it is finally recycled.
 *
 * Resident chunks are gated to every zone except open Offshore water — Offshore has no
 * reef/structure for a school to "belong to" (docs/ARCHITECTURE.md: "same species, same patch
 * reef"), so its species list (`ZONE_LIFE.Offshore`) is only ever reached through the roaming
 * layer. The one exception is the Humps (`HUMPS` in @keysrun/shared/world/depth, `nearestHumpDist`
 * below): Marathon Hump and West Hump are real named relief sitting in Offshore water, exactly the
 * kind of structure a resident school *can* belong to, so a chunk within `HUMP_RADIUS` of one gets
 * `ZONE_LIFE.Humps` residents regardless of the zone underneath it.
 *
 * `lifeTableFor` also splits the Reef zone by depth twice: `REEF_WALL_DEPTH` hands the shallow
 * crest (`ZONE_LIFE.Reef`) off to the wall/ledge table (`ZONE_LIFE.ReefWall`,
 * docs/ARCHITECTURE.md bands 3-4), and `DEEP_WALL_DEPTH` hands that off again to the deep-wall/
 * wreck table (`ZONE_LIFE.DeepWall`, band 5) so the reef doesn't collapse into one table from 12 m
 * all the way to 45 m — "deep bands should feel different from the shallows, not just emptier"
 * (task brief). `ReefWall`, `DeepWall` and `Humps` are habitat refinements layered on top of
 * `zoneAt`'s seven real zones, not zones themselves — see creatures.ts's `ZONE_LIFE` doc comment.
 */
import { hashCell, weightedPick } from '@keysrun/shared/rng';
import { VIS, ZONE_LIFE, type CreatureVis } from '@keysrun/shared/content/creatures';
import { depthAt, zoneAt, WB, HUMPS, type Zone } from '@keysrun/shared/world/depth';
import { shoreInfo, chainZ } from '@keysrun/shared/world/chain';
import { memberScale } from './school.js';
import type { FishMember, SchoolState } from './types.js';

export const CHUNK_SIZE = 64;
/** legacy `VSC` (index.html:2214) — flat visual up-scale applied to every creature. */
export const VSC = 1.35;

const SALT = {
  RESIDENT_GATE: 9001, RESIDENT_SPECIES: 9002, RESIDENT_COUNT: 9003,
  RESIDENT_ANCHOR_X: 9004, RESIDENT_ANCHOR_Z: 9005, RESIDENT_ANCHOR_R: 9006, RESIDENT_HEADING: 9007,
  MEMBER_ANG: 9100, MEMBER_R: 9200, MEMBER_OY: 9300, MEMBER_PHASE: 9400, MEMBER_SCALE: 9500,
  ROAM_GATE: 9601, ROAM_SPECIES: 9602, ROAM_COUNT: 9603, ROAM_OFFSET_X: 9604, ROAM_OFFSET_Z: 9605, ROAM_HEADING: 9606,
  NEAR_GATE: 9701, NEAR_SPECIES: 9702, NEAR_COUNT: 9703, NEAR_OFFSET_X: 9704, NEAR_OFFSET_Z: 9705,
  NEAR_HEADING: 9706, NEAR_ANCHOR_R: 9707, NEAR_BIG: 9708,
} as const;

/**
 * How "busy" each habitat is, 0..1 — structure (reef, bridge pilings, the Humps) carries far more
 * fixed life than open sand/grass. This is the single density knob both layers tune from:
 * `residentsForChunk` gates directly on it; `tryRoamCell` gates on it scaled by
 * `ROAM_DENSITY_FACTOR` (roamers are the sparser layer *on top of* residents, not a second copy of
 * the same density — see this file's header). Keyed by `ZONE_LIFE`'s habitat keys, which include
 * the three non-`Zone` refinements `ReefWall`, `DeepWall` and `Humps` (see creatures.ts's
 * `ZONE_LIFE` doc comment) alongside the seven real `Zone` strings.
 *
 * Raised across the board from this module's original values (task brief: "underwater life is
 * too sparse... raise fish density meaningfully") — draw calls stay bounded regardless (one
 * `InstancedMesh` per *species*, not per fish/school; docs/ARCHITECTURE.md's "< 300 draw calls
 * underwater" is a function of how many distinct species are active at once, not how many
 * individual fish are in their pools — see pool.ts's header), so this is cheap density, exactly
 * the knob docs/ARCHITECTURE.md's "Resident schools"/"Fish at realism and density" sections call
 * for tuning.
 *
 * `Offshore`'s entry only reaches roamers in practice — `lifeTableFor` always returns null for
 * residents in open Offshore water (residents need structure to "belong to"; see `instantiateResident`'s
 * doc comment and docs/ARCHITECTURE.md's "Resident schools" note) — but it still needs a real
 * value here because roamers *are* the pelagic layer offshore.
 */
const HABITAT_DENSITY: Record<string, number> = {
  Creek: 0.48, Flats: 0.5, Backcountry: 0.44, Bridge: 0.72, 'Hawk Channel': 0.62,
  Reef: 0.84, ReefWall: 0.68, DeepWall: 0.58, Offshore: 0.6, Humps: 0.74,
};
/** Roamers sit on top of residents as a sparser, moving layer — see this file's header. */
const ROAM_DENSITY_FACTOR = 0.5;
/** Depth (m) past which the Reef zone's shallow crest table (`ZONE_LIFE.Reef`) hands off to the
 * wall/ledge table (`ZONE_LIFE.ReefWall`) — docs/ARCHITECTURE.md bands 2 (5-10 m, patch reef) vs.
 * 3/4 (10-20 m, reef wall top / ledges): the wall itself only spans dz 1460-1650, dropping
 * 3.4 m -> 45.4 m over 190 m, so this is a depth threshold, not a position threshold. */
const REEF_WALL_DEPTH = 12;
/** Depth (m) past which the wall/ledge table (`ZONE_LIFE.ReefWall`) hands off again to the deep
 * wall/wreck table (`ZONE_LIFE.DeepWall`) — docs/ARCHITECTURE.md band 4 (15-20 m, ledges/
 * overhangs/swim-throughs) vs. band 5 (20 m+, deep wall/wrecks/the Humps, "torch required,
 * blackout risk"). Same depth-not-position reasoning as `REEF_WALL_DEPTH`. */
const DEEP_WALL_DEPTH = 20;
/** Radius (m) within which a named, non-patch Hump's relief visibly concentrates fish — large
 * enough to read as "busier than the open water around it" without swallowing the whole Offshore
 * zone. The two `patch: true` HUMPS entries (Coffins Patch, Delta Shoal) are shallow enough that
 * `zoneAt`/`depthAt` already route them through the normal Flats/Hawk Channel/Reef(Wall) tables —
 * only the two deep offshore bumps (Marathon Hump, West Hump) need this override to host anything
 * at all, since plain Offshore hosts no residents. */
const HUMP_RADIUS = 260;

/** Distance (m) from `(x,z)` to the nearest non-patch Hump, or Infinity if none — see `HUMP_RADIUS`. */
function nearestHumpDist(x: number, z: number): number {
  const dz = z - chainZ(x);
  let best = Infinity;
  for (const H of HUMPS) {
    if (H.patch) continue;
    const d = Math.hypot(x - H.x, dz - H.dz);
    if (d < best) best = d;
  }
  return best;
}

interface LifeTable {
  table: ReadonlyArray<readonly [string, number]>;
  density: number;
}

/**
 * Resolves which `ZONE_LIFE` table and gate density apply at a world point, layering structure
 * (the Humps) and depth (reef crest vs. wall) refinements on top of the plain `zoneAt` zone —
 * see this file's header and creatures.ts's `ZONE_LIFE` doc comment. `allowOffshore` distinguishes
 * the resident caller (open Offshore water hosts no residents — nothing to "belong to" away from a
 * Hump) from the roamer caller (Offshore *is* the pelagic roaming table).
 */
function lifeTableFor(x: number, z: number, zone: Zone, d: number, allowOffshore: boolean): LifeTable | null {
  if (nearestHumpDist(x, z) < HUMP_RADIUS) {
    const table = ZONE_LIFE.Humps;
    if (table && table.length > 0) return { table, density: HABITAT_DENSITY.Humps };
  }
  if (zone === 'Offshore' && !allowOffshore) return null;
  const key: string = zone === 'Reef' && d >= DEEP_WALL_DEPTH ? 'DeepWall'
    : zone === 'Reef' && d >= REEF_WALL_DEPTH ? 'ReefWall' : zone;
  const table = ZONE_LIFE[key];
  if (!table || table.length === 0) return null;
  return { table, density: HABITAT_DENSITY[key] ?? 0.2 };
}

export function chunkOf(x: number, z: number): [number, number] {
  return [Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)];
}

export function chunkKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

function chunkCenter(cx: number, cz: number): [number, number] {
  return [(cx + 0.5) * CHUNK_SIZE, (cz + 0.5) * CHUNK_SIZE];
}

/** Deterministic per-member offsets, scale and VAT swim-phase — shared by residents and roamers
 * so both are equally reproducible given the same (seed, cellX, cellZ, species). */
function buildMembers(seed: number, cx: number, cz: number, V: CreatureVis, count: number, originX: number, originZ: number): FishMember[] {
  const members: FishMember[] = [];
  for (let i = 0; i < count; i++) {
    const ang = hashCell(seed, cx, cz, SALT.MEMBER_ANG + i) * Math.PI * 2;
    const r = Math.sqrt(hashCell(seed, cx, cz, SALT.MEMBER_R + i)) * V.spread;
    const oy = -1 + 2 * hashCell(seed, cx, cz, SALT.MEMBER_OY + i);
    const swimPhase = hashCell(seed, cx, cz, SALT.MEMBER_PHASE + i) * Math.PI * 2;
    const baseScale = VSC * (0.8 + 0.35 * hashCell(seed, cx, cz, SALT.MEMBER_SCALE + i));
    members.push({
      slot: -1, ox: Math.cos(ang) * r, oz: Math.sin(ang) * r, oy, swimPhase,
      scale: memberScale(baseScale, V, originX, originZ),
      act: null, actPhase: 0, actTimer: 1 + 7 * hashCell(seed, cx, cz, SALT.MEMBER_PHASE + 500 + i),
      splashed: false, splashed2: false, breaching: false,
      wx: originX, wy: 0, wz: originZ, yaw: 0, pitch: 0, roll: 0, worldScale: 0,
    });
  }
  return members;
}

export interface ResidentSpec {
  type: string;
  V: CreatureVis;
  anchorX: number;
  anchorZ: number;
  anchorR: number;
  heading: number;
  diveTimerSeed: number;
  members: FishMember[];
}

/**
 * Pure: `(seed, cx, cz)` -> the resident school for that chunk, or null if the chunk hosts none
 * (wrong zone, wrong depth, or the density roll came up empty). Calling this twice with the same
 * arguments always returns an equivalent result — see test/fish-spawn.test.ts.
 */
export function residentsForChunk(seed: number, cx: number, cz: number): ResidentSpec | null {
  const [ccx, ccz] = chunkCenter(cx, cz);
  const zone = zoneAt(ccx, ccz);
  const life = lifeTableFor(ccx, ccz, zone, depthAt(ccx, ccz), false);
  if (!life) return null;
  if (hashCell(seed, cx, cz, SALT.RESIDENT_GATE) >= life.density) return null;

  const type = weightedPick(() => hashCell(seed, cx, cz, SALT.RESIDENT_SPECIES), life.table);
  const V = VIS[type];
  if (!V) return null;

  const anchorX = ccx + (hashCell(seed, cx, cz, SALT.RESIDENT_ANCHOR_X) - 0.5) * CHUNK_SIZE * 0.7;
  const anchorZ = ccz + (hashCell(seed, cx, cz, SALT.RESIDENT_ANCHOR_Z) - 0.5) * CHUNK_SIZE * 0.7;
  const d = depthAt(anchorX, anchorZ);
  if (d < V.dMin || d > V.dMax || shoreInfo(anchorX, anchorZ).d < 4) return null;
  if (anchorX < WB.x0 || anchorX > WB.x1 || anchorZ < WB.z0 || anchorZ > WB.z1) return null;

  const count = V.school[0] + Math.floor(hashCell(seed, cx, cz, SALT.RESIDENT_COUNT) * (V.school[1] - V.school[0] + 1));
  const anchorR = 6 + 10 * hashCell(seed, cx, cz, SALT.RESIDENT_ANCHOR_R);
  const heading = hashCell(seed, cx, cz, SALT.RESIDENT_HEADING) * Math.PI * 2;
  const diveTimerSeed = hashCell(seed, cx, cz, SALT.RESIDENT_HEADING + 1);
  const members = buildMembers(seed, cx, cz, V, count, anchorX, anchorZ);
  return { type, V, anchorX, anchorZ, anchorR, heading, diveTimerSeed, members };
}

/** Builds the live `SchoolState` for a resident chunk — called when the chunk enters activation
 * range. `members[i].slot` is still -1; the caller (index.ts) allocates pool slots right after. */
export function instantiateResident(spec: ResidentSpec, cx: number, cz: number): SchoolState {
  return {
    id: `res:${chunkKey(cx, cz)}`,
    type: spec.type,
    cx: spec.anchorX, cz: spec.anchorZ, heading: spec.heading,
    phase: spec.heading * 17.3, turn: 0, flee: 0, fleeHeading: spec.heading, bowRide: 0,
    glide: 0, dive: 0, diveTimer: 6 + 8 * spec.diveTimerSeed, diveTarget: 0,
    anchor: { x: spec.anchorX, z: spec.anchorZ, r: spec.anchorR },
    resident: true,
    members: spec.members,
  };
}

// --- roaming layer -------------------------------------------------------

export const ROAM_CELL = 48;
export const ROAM_MIN_R = 50;
/** Roamers now reach well past the old 190 m cliff — see this file's header and the task brief's
 * "scale density to view distance": topside view distance is ~1900 m, and a hard stop at 190 m
 * is exactly the "looks good up close, dies at range" failure mode being fixed. 320 m keeps the
 * instance/triangle cost bounded (`ROAM_TARGET` below, plus pool.ts's capacity headroom) while
 * roughly tripling the area that can host a roamer relative to the old [50,190] annulus. */
export const ROAM_MAX_R = 320;
/** Scaled up from the roamer radius increase (see `ROAM_MAX_R`), but sub-linearly — the point is
 * a lower-density *penumbra* beyond the resident radius, not uniformly re-flooding a 3x area.
 * Raised alongside `HABITAT_DENSITY` (task brief: "underwater life is too sparse") — still cheap:
 * roamers reuse the same per-species `InstancedMesh` pools residents do, so more of them costs
 * instances/triangles, not draw calls (pool.ts's header). */
export const ROAM_TARGET = 52;
export const DORMANT_TTL_S = 90;

export interface RoamSpawn {
  type: string;
  V: CreatureVis;
  x: number;
  z: number;
  heading: number;
  members: FishMember[];
}

/** One deterministic roll for a single roamer candidate cell — legacy `trySpawn`'s per-attempt
 * body (index.html:2490-2502), but keyed by the cell's own coordinates (`hashCell`) instead of
 * `Math.random()`, so the decision is placement-derived, not iteration-order-derived. Density and
 * table come from `lifeTableFor` with `allowOffshore: true` — roamers are the only layer that ever
 * reaches `ZONE_LIFE.Offshore` (see this file's header), scaled by `ROAM_DENSITY_FACTOR` since
 * roamers sit on top of residents rather than duplicating their density. */
export function tryRoamCell(seed: number, cellX: number, cellZ: number): RoamSpawn | null {
  const [cx, cz] = [cellX * ROAM_CELL + ROAM_CELL / 2, cellZ * ROAM_CELL + ROAM_CELL / 2];
  const zone = zoneAt(cx, cz);
  const life = lifeTableFor(cx, cz, zone, depthAt(cx, cz), true);
  if (!life) return null;
  if (hashCell(seed, cellX, cellZ, SALT.ROAM_GATE) >= life.density * ROAM_DENSITY_FACTOR) return null;
  const type = weightedPick(() => hashCell(seed, cellX, cellZ, SALT.ROAM_SPECIES), life.table);
  const V = VIS[type];
  if (!V) return null;
  const x = cx + (hashCell(seed, cellX, cellZ, SALT.ROAM_OFFSET_X) - 0.5) * ROAM_CELL;
  const z = cz + (hashCell(seed, cellX, cellZ, SALT.ROAM_OFFSET_Z) - 0.5) * ROAM_CELL;
  const d = depthAt(x, z);
  if (d < V.dMin || d > V.dMax || shoreInfo(x, z).d < 4) return null;
  if (x < WB.x0 || x > WB.x1 || z < WB.z0 || z > WB.z1) return null;
  const count = V.school[0] + Math.floor(hashCell(seed, cellX, cellZ, SALT.ROAM_COUNT) * (V.school[1] - V.school[0] + 1));
  const heading = hashCell(seed, cellX, cellZ, SALT.ROAM_HEADING) * Math.PI * 2;
  const members = buildMembers(seed, cellX, cellZ, V, count, x, z);
  return { type, V, x, z, heading, members };
}

let roamCounter = 0;
export function instantiateRoamer(spawn: RoamSpawn): SchoolState {
  roamCounter = (roamCounter + 1) % 1_000_000;
  return {
    id: `roam:${roamCounter}`,
    type: spawn.type,
    cx: spawn.x, cz: spawn.z, heading: spawn.heading,
    phase: spawn.heading * 11.7, turn: 0, flee: 0, fleeHeading: spawn.heading, bowRide: 0,
    glide: 0, dive: 0, diveTimer: 6, diveTarget: 0,
    anchor: null, resident: false,
    members: spawn.members,
  };
}

// --- near-field layer ----------------------------------------------------
//
// The layer that actually puts fish in front of your mask.
//
// Residents are rolled once per 64 m chunk out to a 220 m radius, and roamers sit in a 50-320 m
// annulus. Both are tuned to the *topside* view, where the horizon is 1,900 m away and a school
// 200 m off is a legitimate thing to see. Underwater, visibility is 10-30 m
// (world/underwater/depth-bands.ts). Measured on the Sombrero crest before this existed: 23
// active schools, ~195 fish, and **zero of them within 25 m** — the entire population was spread
// across an annulus whose area is ~100x the sphere a diver can actually see into, so the expected
// fish-in-frame was a fraction of one. Standing on the best reef in the game showed empty water.
//
// This is a third, much finer layer: 18 m cells, activated only inside `NEAR_RADIUS`, rolled from
// the same `hashCell` machinery (so it is just as deterministic and just as shared-world-safe as
// the other two) but biased hard toward species that genuinely shoal. It is affordable only
// because of the per-frame LOD/culling in pool.ts/render.ts — at the old flat ~1,800 triangles per
// fish at every distance, this many fish was arithmetically impossible.
export const NEAR_CELL = 18;
/** Activation radius. Comfortably past the ~30 m best-case visibility so schools are already
 * there, already swimming, when they fade in — rather than popping at the edge of sight. */
export const NEAR_RADIUS = 72;
/** Gate scale on top of `HABITAT_DENSITY`. Well above 1: this layer's whole job is to be dense,
 * and its cells are small enough that a high hit rate still reads as scattered groups rather than
 * a uniform carpet. */
const NEAR_DENSITY_FACTOR = 2.6;
/** A species must shoal at least this many strong to be eligible. Filters the near field down to
 * the fish that actually form the "schools of them" a reef is supposed to show — snapper, runners,
 * grunts, mackerel — and leaves solitary ambush predators (grouper, barracuda, goliath) to the
 * resident layer, where one of them holding a ledge is the point. */
const NEAR_MIN_SCHOOL = 4;
/**
 * Chance that a near-field cell rolls a **big solitary fish** instead of a shoal.
 *
 * Without this the near field was shoaling species only, by construction — so the dense layer the
 * diver actually swims through contained nothing but small schooling fish, and every grouper,
 * barracuda, tarpon, shark and ray was left to the sparse 220 m resident layer where you almost
 * never meet one. That is the opposite of the intent: the brief's whole point is that the big
 * fish are the star, and the small schools are the thing that reacts to them.
 *
 * Deliberately a minority of cells. A reef where every patch holds a grouper is as wrong as one
 * holding none — the point is that you round a coral head and there is something big there.
 */
const NEAR_BIG_CHANCE = 0.22;
/** A species qualifies as a "big" near-field pick on body length, not school size — this is about
 * what reads as substantial at 10 m underwater. */
const NEAR_BIG_MIN_LEN = 0.85;

/** `ZONE_LIFE` filtered to the big-bodied species — the near field's "statement fish" pick.
 * Marine mammals stay excluded here too: a manatee or a dolphin pod is an event the resident/
 * roaming layers own, and making them a 1-in-5 cell roll would cheapen them. */
const _bigTables = new Map<string, ReadonlyArray<readonly [string, number]>>();
function bigTable(key: string, table: ReadonlyArray<readonly [string, number]>): ReadonlyArray<readonly [string, number]> {
  const hit = _bigTables.get(key);
  if (hit) return hit;
  const out = table.filter(([k]) => {
    const V = VIS[k];
    return !!V && V.len >= NEAR_BIG_MIN_LEN && V.catchable !== false;
  });
  _bigTables.set(key, out);
  return out;
}

/** `ZONE_LIFE` table filtered to the shoaling species, with weights re-normalised. Memoised per
 * habitat key because it is pure and is otherwise recomputed for every candidate cell. */
const _nearTables = new Map<string, ReadonlyArray<readonly [string, number]>>();
function shoalingTable(key: string, table: ReadonlyArray<readonly [string, number]>): ReadonlyArray<readonly [string, number]> {
  const hit = _nearTables.get(key);
  if (hit) return hit;
  const out = table.filter(([k]) => {
    const V = VIS[k];
    // `catchable: false` excludes the marine mammals — a pod of dolphins is an event, not scenery,
    // and multiplying them by this layer's density would cheapen exactly what makes them special.
    return !!V && V.school[1] >= NEAR_MIN_SCHOOL && V.catchable !== false;
  });
  _nearTables.set(key, out);
  return out;
}

/** Pure: `(seed, cellX, cellZ)` -> a dense near-field school for that 18 m cell, or null. Same
 * contract as `residentsForChunk` — calling it twice with the same arguments gives the same
 * school, so two divers on the same patch reef see the same fish. */
export function nearFieldForCell(seed: number, cellX: number, cellZ: number): ResidentSpec | null {
  const cx = cellX * NEAR_CELL + NEAR_CELL / 2;
  const cz = cellZ * NEAR_CELL + NEAR_CELL / 2;
  const d = depthAt(cx, cz);
  const life = lifeTableFor(cx, cz, zoneAt(cx, cz), d, true);
  if (!life) return null;
  if (hashCell(seed, cellX, cellZ, SALT.NEAR_GATE) >= life.density * NEAR_DENSITY_FACTOR) return null;

  // A minority of cells hold a big solitary fish rather than a shoal — see NEAR_BIG_CHANCE.
  const tableKey = `${life.table.length}:${life.density}`;
  const wantBig = hashCell(seed, cellX, cellZ, SALT.NEAR_BIG) < NEAR_BIG_CHANCE;
  const big = wantBig ? bigTable(tableKey, life.table) : [];
  const table = big.length > 0 ? big : shoalingTable(tableKey, life.table);
  if (table.length === 0) return null;

  const type = weightedPick(() => hashCell(seed, cellX, cellZ, SALT.NEAR_SPECIES), table);
  const V = VIS[type];
  if (!V) return null;

  const anchorX = cx + (hashCell(seed, cellX, cellZ, SALT.NEAR_OFFSET_X) - 0.5) * NEAR_CELL;
  const anchorZ = cz + (hashCell(seed, cellX, cellZ, SALT.NEAR_OFFSET_Z) - 0.5) * NEAR_CELL;
  const ad = depthAt(anchorX, anchorZ);
  if (ad < V.dMin || ad > V.dMax || shoreInfo(anchorX, anchorZ).d < 4) return null;
  if (anchorX < WB.x0 || anchorX > WB.x1 || anchorZ < WB.z0 || anchorZ > WB.z1) return null;

  const count = V.school[0] + Math.floor(hashCell(seed, cellX, cellZ, SALT.NEAR_COUNT) * (V.school[1] - V.school[0] + 1));
  // Tighter orbit than a resident's 6-16 m: these are schools holding on a single coral head or
  // sand patch, not patrolling a whole chunk.
  const anchorR = 3 + 6 * hashCell(seed, cellX, cellZ, SALT.NEAR_ANCHOR_R);
  const heading = hashCell(seed, cellX, cellZ, SALT.NEAR_HEADING) * Math.PI * 2;
  const members = buildMembers(seed, cellX, cellZ, V, count, anchorX, anchorZ);
  return { type, V, anchorX, anchorZ, anchorR, heading, diveTimerSeed: hashCell(seed, cellX, cellZ, SALT.NEAR_HEADING + 1), members };
}

export function nearCellOf(x: number, z: number): [number, number] {
  return [Math.floor(x / NEAR_CELL), Math.floor(z / NEAR_CELL)];
}

export function nearKey(cellX: number, cellZ: number): string {
  return `n:${cellX},${cellZ}`;
}

/** Builds the live school for a near-field cell. Mirrors `instantiateResident`; the separate id
 * prefix keeps the two layers' keyspaces from ever colliding. */
export function instantiateNearField(spec: ResidentSpec, cellX: number, cellZ: number): SchoolState {
  return {
    id: nearKey(cellX, cellZ),
    type: spec.type,
    cx: spec.anchorX, cz: spec.anchorZ, heading: spec.heading,
    phase: spec.heading * 23.1, turn: 0, flee: 0, fleeHeading: spec.heading, bowRide: 0,
    glide: 0, dive: 0, diveTimer: 4 + 7 * spec.diveTimerSeed, diveTarget: 0,
    anchor: { x: spec.anchorX, z: spec.anchorZ, r: spec.anchorR },
    resident: true,
    members: spec.members,
  };
}
