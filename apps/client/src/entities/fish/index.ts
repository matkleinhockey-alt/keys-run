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
import { stepSchool } from './school.js';
import { renderSchool, finalizePoolRender } from './render.js';
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
  update(dt: number, t: number, focus: { x: number; z: number }, boatSpeed: number, extraThreats?: Threat[]): void;
  readonly stats: { schools: number; fish: number; draws: number };
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

  function update(dt: number, t: number, focus: { x: number; z: number }, boatSpeed: number, extraThreats: Threat[] = []): void {
    swimClock.value = t;
    throttle -= dt;
    if (throttle <= 0) {
      throttle = SPAWN_THROTTLE_S;
      updateResidents(focus);
      manageRoamers(focus, t);
    }

    const threats: Threat[] = [{ x: focus.x, z: focus.z, kind: 'boat', speed: boatSpeed }, ...extraThreats];
    const ctx = { t, dt, threats };

    let fishCount = 0;
    const touched = new Set<SpeciesPool>();
    for (const state of residents.values()) {
      const pool = pools.get(state.type);
      if (!pool) continue;
      stepSchool(state, pool.V, ctx);
      renderSchool(state, pool);
      touched.add(pool);
      fishCount += state.members.length;
    }
    for (const state of roamers.values()) {
      const pool = pools.get(state.type);
      if (!pool) continue;
      stepSchool(state, pool.V, ctx);
      renderSchool(state, pool);
      touched.add(pool);
      fishCount += state.members.length;
    }
    for (const pool of touched) finalizePoolRender(pool);

    stats.schools = residents.size + roamers.size;
    stats.fish = fishCount;
    stats.draws = touched.size;
  }

  return { group, update, stats };
}
