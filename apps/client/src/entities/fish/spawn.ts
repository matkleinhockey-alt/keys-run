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
 * Resident chunks are gated to every zone except Offshore — Offshore has no reef/structure for a
 * school to "belong to" (docs/ARCHITECTURE.md: "same species, same patch reef"), so its species
 * list (`ZONE_LIFE.Offshore`) is only ever reached through the roaming layer.
 */
import { hashCell, weightedPick } from '@keysrun/shared/rng';
import { VIS, ZONE_LIFE, type CreatureVis } from '@keysrun/shared/content/creatures';
import { depthAt, zoneAt, WB, type Zone } from '@keysrun/shared/world/depth';
import { shoreInfo } from '@keysrun/shared/world/chain';
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
} as const;

/** Resident density per zone — reef and structure-rich zones carry more fixed schools than open
 * sand/grass. Purely a tuning table, not gameplay-critical maths. */
const RESIDENT_DENSITY: Partial<Record<Zone, number>> = {
  Reef: 0.62, 'Hawk Channel': 0.38, Flats: 0.3, Backcountry: 0.24, Bridge: 0.5, Creek: 0.28,
};

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
      splashed: false, wx: originX, wy: 0, wz: originZ, yaw: 0, pitch: 0, roll: 0, worldScale: 0,
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
  if (zone === 'Offshore') return null;
  const density = RESIDENT_DENSITY[zone] ?? 0.2;
  if (hashCell(seed, cx, cz, SALT.RESIDENT_GATE) >= density) return null;

  const table = ZONE_LIFE[zone];
  if (!table || table.length === 0) return null;
  const type = weightedPick(() => hashCell(seed, cx, cz, SALT.RESIDENT_SPECIES), table);
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
    phase: spec.heading * 17.3, turn: 0, flee: 0, fleeHeading: spec.heading,
    glide: 0, dive: 0, diveTimer: 6 + 8 * spec.diveTimerSeed, diveTarget: 0,
    anchor: { x: spec.anchorX, z: spec.anchorZ, r: spec.anchorR },
    resident: true,
    members: spec.members,
  };
}

// --- roaming layer -------------------------------------------------------

export const ROAM_CELL = 48;
export const ROAM_MIN_R = 50;
export const ROAM_MAX_R = 190;
export const ROAM_TARGET = 18;
export const DORMANT_TTL_S = 60;
const ROAM_GATE_DENSITY = 0.22;

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
 * `Math.random()`, so the decision is placement-derived, not iteration-order-derived. */
export function tryRoamCell(seed: number, cellX: number, cellZ: number): RoamSpawn | null {
  if (hashCell(seed, cellX, cellZ, SALT.ROAM_GATE) >= ROAM_GATE_DENSITY) return null;
  const [cx, cz] = [cellX * ROAM_CELL + ROAM_CELL / 2, cellZ * ROAM_CELL + ROAM_CELL / 2];
  const zone = zoneAt(cx, cz);
  const table = ZONE_LIFE[zone];
  if (!table || table.length === 0) return null;
  const type = weightedPick(() => hashCell(seed, cellX, cellZ, SALT.ROAM_SPECIES), table);
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
    phase: spawn.heading * 11.7, turn: 0, flee: 0, fleeHeading: spawn.heading,
    glide: 0, dive: 0, diveTimer: 6, diveTarget: 0,
    anchor: null, resident: false,
    members: spawn.members,
  };
}
