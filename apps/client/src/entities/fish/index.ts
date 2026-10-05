/**
 * `createFishWorld`: the orchestrator — owns one `SpeciesPool` per VIS species (legacy's
 * `VGEO`/`VMESH`/`VFREE` boot loop, index.html:2478-2486), activates/retires resident schools as
 * their chunk enters/leaves range, manages the roaming layer (spawn, dormant, recycle), and
 * steps+renders every active school once a frame — legacy's `updateCreatures`
 * (index.html:2541-2600) plus the deterministic-spawning replacement for `managePopulation`
 * (spawn.ts) that docs/ARCHITECTURE.md's "Resident schools" section calls for.
 *
 * This is the one file in entities/fish that game/world.ts actually calls. Everything else here
 * is plumbing: species pools (pool.ts/materials.ts/vat.ts), pure simulation (school.ts/
 * behavior.ts), and deterministic placement (spawn.ts).
 */
import * as THREE from 'three';
import { VIS } from '@keysrun/shared/content/creatures';
import { createSpeciesPool, allocSlot, freeSlot, type SpeciesPool } from './pool.js';
import { stepSchool, waterColumnAt } from './school.js';
import { renderSchool, finalizePoolRender } from './render.js';
import { createSpoutSystem } from './spout.js';
import {
  chunkOf, chunkKey, residentsForChunk, instantiateResident,
  tryRoamCell, instantiateRoamer, ROAM_CELL, ROAM_MIN_R, ROAM_MAX_R, ROAM_TARGET, DORMANT_TTL_S,
} from './spawn.js';
import { swimClock } from './swim-clock.js';
import type { SchoolState, Threat } from './types.js';
import { WORLD_SEED } from '../../state/constants.js';

const RESIDENT_RADIUS = 220;
const SPAWN_THROTTLE_S = 0.4; // legacy `popT` cadence (index.html:2542)
const ROAM_RETIRE_R = ROAM_MAX_R + 40; // legacy's `POP_R+40` free radius

export interface FishWorld {
  group: THREE.Group;
  /**
   * `focus` is the point population *activates around* — docs/ARCHITECTURE.md "Fish ownership"
   * requires this to follow whichever viewer is actually in the water, not an anchored hull: the
   * caller (game/world.ts) passes the diver's position while `diver.mode === 'diver'`, falling
   * back to the boat otherwise. `boat` is always the boat's own real position/speed, independent
   * of `focus` — the hull is a standing threat to nearby fish even while its driver is over the
   * side and the population focus has moved to the diver (see world.ts's call site).
   */
  update(dt: number, t: number, focus: { x: number; z: number }, boat: Threat, extraThreats?: Threat[]): void;
  readonly stats: { schools: number; fish: number; draws: number };
  /** Scans resident chunks (via the same pure `residentsForChunk` activation uses — no game
   * state touched) outward from `(originX, originZ)` out to `maxRadius` for the first species
   * matching `wantType`. Verification-only (Playwright screenshot targeting — see
   * test/capture-fish-screenshots.mjs): deterministic spawning means "where is the nearest X"
   * is itself a pure query, so this needs no debug-only game-state backdoor to answer it. */
  findResidentNear(wantType: string, originX: number, originZ: number, maxRadius: number): { x: number; z: number } | null;
  /** Floor/surface world-Y at a point — verification-only passthrough to school.ts's
   * `waterColumnAt`, used by test/capture-fish-screenshots.mjs to place a camera at a sensible
   * height in the water column instead of guessing a world Y blind. */
  waterColumnAt(x: number, z: number, t: number): { floor: number; surf: number };
  /** Verification-only: every currently active school's centroid/type/member-count. */
  debugActiveSchools(): Array<{ id: string; type: string; cx: number; cz: number; heading: number; count: number; resident: boolean }>;
  /** Verification-only: per-species-pool draw-call/triangle accounting, isolated from the rest of
   * the scene. */
  debugPoolStats(): Array<{ type: string; triPerInstance: number; meshCount: number; inUse: number; capacity: number }>;
  /** Verification-only: running count of 'blow' SchoolEvents consumed since world creation — lets
   * a screenshot script (test/capture-mammals-screenshots.mjs) confirm a whale has actually blown
   * at least once instead of guessing from a screenshot whether it just hasn't happened yet. */
  debugBlowCount(): number;
}

interface DormantEntry {
  state: SchoolState;
  since: number;
}

export function createFishWorld(seed: number = WORLD_SEED): FishWorld {
  const group = new THREE.Group();
  group.name = 'fish';

  const pools = new Map<string, SpeciesPool>();
  for (const [key, V] of Object.entries(VIS)) pools.set(key, createSpeciesPool(group, key, V));

  const residents = new Map<string, SchoolState>(); // chunkKey -> active resident
  const roamers = new Map<string, SchoolState>(); // id -> active roamer
  const dormant = new Map<string, DormantEntry>(); // id -> frozen roamer

  // Whale blow/spout visual — see spout.ts. One shared effect pool for the whole fish world,
  // fed by 'blow' SchoolEvents (school.ts's stepMember) below.
  const spoutSystem = createSpoutSystem(group);

  // Bow-riding (behavior.ts/school.ts) needs the boat's *heading*, which the `Threat` the boat is
  // passed as doesn't carry (sim/boat.ts's Threat shape is x/z/speed only — see types.ts). Rather
  // than touch game/world.ts's boat-sim plumbing (out of this module's scope), heading is
  // reconstructed here from the boat's own frame-to-frame displacement — cheap, and exactly
  // equivalent for a planing hull that doesn't instantaneously strafe sideways.
  let lastBoatX: number | null = null, lastBoatZ: number | null = null, lastBoatHeading = 0;

  let blowCount = 0;

  let throttle = 0;

  function allocateMembers(state: SchoolState): boolean {
    const pool = pools.get(state.type);
    if (!pool) return false;
    const taken: number[] = [];
    for (const m of state.members) {
      const slot = allocSlot(pool, m.swimPhase);
      if (slot === null) { for (const s of taken) freeSlot(pool, s); return false; }
      m.slot = slot;
      taken.push(slot);
    }
    return true;
  }

  function releaseMembers(state: SchoolState): void {
    const pool = pools.get(state.type);
    if (!pool) return;
    for (const m of state.members) { if (m.slot >= 0) freeSlot(pool, m.slot); m.slot = -1; }
  }

  function updateResidents(focus: { x: number; z: number }): void {
    const [fcx, fcz] = chunkOf(focus.x, focus.z);
    const reach = Math.ceil(RESIDENT_RADIUS / 64);
    const wanted = new Set<string>();
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const cx = fcx + dx, cz = fcz + dz;
        if (Math.hypot(dx, dz) * 64 > RESIDENT_RADIUS) continue;
        const key = chunkKey(cx, cz);
        wanted.add(key);
        if (residents.has(key)) continue;
        const spec = residentsForChunk(seed, cx, cz);
        if (!spec) continue;
        const state = instantiateResident(spec, cx, cz);
        if (allocateMembers(state)) residents.set(key, state);
      }
    }
    for (const [key, state] of residents) {
      if (!wanted.has(key)) { releaseMembers(state); residents.delete(key); }
    }
  }

  function manageRoamers(focus: { x: number; z: number }, t: number): void {
    // retire out-of-range active roamers to the dormant list instead of deleting them —
    // see spawn.ts's header for why this is what actually fixes "turning around re-rolls the reef"
    for (const [id, state] of roamers) {
      if (Math.hypot(state.cx - focus.x, state.cz - focus.z) > ROAM_RETIRE_R) {
        releaseMembers(state);
        roamers.delete(id);
        dormant.set(id, { state, since: t });
      }
    }
    // drop dormant roamers whose TTL expired; reactivate the rest if back in range
    for (const [id, entry] of dormant) {
      if (t - entry.since > DORMANT_TTL_S) { dormant.delete(id); continue; }
      if (Math.hypot(entry.state.cx - focus.x, entry.state.cz - focus.z) <= ROAM_MAX_R) {
        if (allocateMembers(entry.state)) { roamers.set(id, entry.state); dormant.delete(id); }
      }
    }
    // top up the roaming population — candidate cells are chosen with Math.random (scan order
    // only; cosmetic), but *what* spawns there is entirely hashCell(seed, cellX, cellZ, ...)
    // (spawn.ts), so re-rolling the same cell later always offers the same thing.
    let attempts = 0;
    while (roamers.size < ROAM_TARGET && attempts < 6) {
      attempts++;
      const ang = Math.random() * Math.PI * 2;
      const r = ROAM_MIN_R + Math.random() * (ROAM_MAX_R - ROAM_MIN_R);
      const x = focus.x + Math.cos(ang) * r, z = focus.z + Math.sin(ang) * r;
      const [cellX, cellZ] = [Math.floor(x / ROAM_CELL), Math.floor(z / ROAM_CELL)];
      let crowded = false;
      for (const s of roamers.values()) { if (Math.hypot(s.cx - x, s.cz - z) < 25) { crowded = true; break; } }
      if (crowded) continue;
      const spawnSpec = tryRoamCell(seed, cellX, cellZ);
      if (!spawnSpec) continue;
      const state = instantiateRoamer(spawnSpec);
      if (allocateMembers(state)) roamers.set(state.id, state);
    }
  }

  const stats = { schools: 0, fish: 0, draws: 0 };

  function update(dt: number, t: number, focus: { x: number; z: number }, boat: Threat, extraThreats: Threat[] = []): void {
    swimClock.value = t;
    throttle -= dt;
    if (throttle <= 0) {
      throttle = SPAWN_THROTTLE_S;
      updateResidents(focus);
      manageRoamers(focus, t);
    }

    // Reconstruct the boat's heading from its own displacement (see this module's header on why
    // `boat: Threat` alone isn't enough for bow-riding) — guarded against near-zero movement so a
    // drifting/idling boat doesn't make the heading jitter frame to frame.
    let boatWithHeading: Threat = boat;
    if (lastBoatX !== null && lastBoatZ !== null) {
      const dx = boat.x - lastBoatX, dz = boat.z - lastBoatZ;
      if (Math.hypot(dx, dz) > 0.02) lastBoatHeading = Math.atan2(-dx, -dz);
      boatWithHeading = { ...boat, heading: lastBoatHeading };
    }
    lastBoatX = boat.x; lastBoatZ = boat.z;

    const threats: Threat[] = [boatWithHeading, ...extraThreats];
    const ctx = { t, dt, threats };

    let fishCount = 0;
    const touched = new Set<SpeciesPool>();
    for (const state of residents.values()) {
      const pool = pools.get(state.type);
      if (!pool) continue;
      const events = stepSchool(state, pool.V, ctx);
      for (const ev of events) if (ev.type === 'blow') { spoutSystem.spawn(ev.x, ev.y, ev.z); blowCount++; }
      renderSchool(state, pool);
      touched.add(pool);
      fishCount += state.members.length;
    }
    for (const state of roamers.values()) {
      const pool = pools.get(state.type);
      if (!pool) continue;
      const events = stepSchool(state, pool.V, ctx);
      for (const ev of events) if (ev.type === 'blow') { spoutSystem.spawn(ev.x, ev.y, ev.z); blowCount++; }
      renderSchool(state, pool);
      touched.add(pool);
      fishCount += state.members.length;
    }
    for (const pool of touched) finalizePoolRender(pool);
    spoutSystem.update(dt);

    stats.schools = residents.size + roamers.size;
    stats.fish = fishCount;
    stats.draws = touched.size;
  }

  /** Verification-only: the fish system's own draw-call/triangle contribution in isolation from
   * the rest of the (still fully topside-rendered, in this branch) scene — see pool.ts's
   * `mesh.count` high-water-mark doc comment for why `meshCount` (not `capacity`) is what actually
   * gets submitted to the GPU. */
  function debugPoolStats(): Array<{ type: string; triPerInstance: number; meshCount: number; inUse: number; capacity: number }> {
    const out: Array<{ type: string; triPerInstance: number; meshCount: number; inUse: number; capacity: number }> = [];
    for (const pool of pools.values()) {
      if (pool.inUse === 0) continue;
      const pos = pool.mesh.geometry.attributes.position;
      const idx = pool.mesh.geometry.index;
      const triPerInstance = idx ? idx.count / 3 : pos.count / 3;
      out.push({ type: pool.key, triPerInstance, meshCount: pool.mesh.count, inUse: pool.inUse, capacity: pool.capacity });
    }
    return out;
  }

  function debugActiveSchools(): Array<{ id: string; type: string; cx: number; cz: number; heading: number; count: number; resident: boolean }> {
    const out: Array<{ id: string; type: string; cx: number; cz: number; heading: number; count: number; resident: boolean }> = [];
    for (const s of residents.values()) out.push({ id: s.id, type: s.type, cx: s.cx, cz: s.cz, heading: s.heading, count: s.members.length, resident: true });
    for (const s of roamers.values()) out.push({ id: s.id, type: s.type, cx: s.cx, cz: s.cz, heading: s.heading, count: s.members.length, resident: false });
    return out;
  }

  function findResidentNear(wantType: string, originX: number, originZ: number, maxRadius: number): { x: number; z: number } | null {
    const [ocx, ocz] = chunkOf(originX, originZ);
    const reach = Math.ceil(maxRadius / 64);
    let best: { x: number; z: number } | null = null, bestD = Infinity;
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const spec = residentsForChunk(seed, ocx + dx, ocz + dz);
        if (!spec || spec.type !== wantType) continue;
        const d = Math.hypot(spec.anchorX - originX, spec.anchorZ - originZ);
        if (d < bestD) { bestD = d; best = { x: spec.anchorX, z: spec.anchorZ }; }
      }
    }
    return best;
  }

  function debugBlowCount(): number { return blowCount; }

  return { group, update, stats, findResidentNear, waterColumnAt, debugActiveSchools, debugPoolStats, debugBlowCount };
}
