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
import { createSpeciesPool, beginPoolFrame, endPoolFrame, type SpeciesPool } from './pool.js';
import { stepSchool, waterColumnAt } from './school.js';
import { renderSchool, beginRenderStats, renderStats, type RenderView } from './render.js';
import { createSpoutSystem } from './spout.js';
import {
  chunkOf, chunkKey, residentsForChunk, instantiateResident,
  tryRoamCell, instantiateRoamer, ROAM_CELL, ROAM_MIN_R, ROAM_MAX_R, ROAM_TARGET, DORMANT_TTL_S,
  nearFieldForCell, instantiateNearField, nearCellOf, nearKey, NEAR_CELL, NEAR_RADIUS,
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
  /** The camera every LOD/cull decision is made against (render.ts). Separate from `focus`
   * (which is the *population* centre — the diver or the boat) because the two genuinely differ:
   * in the chase camera the eye sits metres behind the hull, and while diving the camera is at
   * eye height rather than at the diver's own origin. Call once per frame before `update`. */
  setCamera(camera: THREE.Camera): void;
  readonly stats: {
    schools: number; fish: number; draws: number;
    /** Instances actually submitted to the GPU this frame, after distance+frustum culling. */
    drawnFish: number;
    culledDistance: number;
    culledFrustum: number;
    /** Submitted instances per detail tier — the headline LOD-is-working number: a busy reef
     * should be mostly 'impostor'/'coarse', with only what you are close to in 'low'. */
    byTier: Readonly<Record<string, number>>;
    triangles: number;
    /** World position the LOD/cull decision was evaluated from this frame. Permanently useful:
     * if this ever diverges from where the viewer actually is, every fish culls at once. */
    camX: number; camY: number; camZ: number;
  };
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
  debugPoolStats(): Array<{ type: string; lod: string; triPerInstance: number; instances: number; capacity: number }>;
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
  // The dense 18 m-cell layer inside NEAR_RADIUS — see spawn.ts's "near-field layer" header for
  // why the resident/roamer layers alone left a diver standing in empty water.
  const nearField = new Map<string, SchoolState>();
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

  // Activating/retiring a school used to have to reserve (and could fail to reserve) a stable
  // InstancedMesh slot per member. Instances are assigned per frame now (pool.ts), so activation
  // is pure bookkeeping and can never be refused for lack of room — see pool.ts's header.

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
        residents.set(key, instantiateResident(spec, cx, cz));
      }
    }
    for (const key of residents.keys()) {
      if (!wanted.has(key)) residents.delete(key);
    }
  }

  function updateNearField(focus: { x: number; z: number }): void {
    const [fcx, fcz] = nearCellOf(focus.x, focus.z);
    const reach = Math.ceil(NEAR_RADIUS / NEAR_CELL);
    const wanted = new Set<string>();
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dz = -reach; dz <= reach; dz++) {
        if (Math.hypot(dx, dz) * NEAR_CELL > NEAR_RADIUS) continue;
        const cellX = fcx + dx, cellZ = fcz + dz;
        const key = nearKey(cellX, cellZ);
        wanted.add(key);
        if (nearField.has(key)) continue;
        const spec = nearFieldForCell(seed, cellX, cellZ);
        if (!spec) continue;
        nearField.set(key, instantiateNearField(spec, cellX, cellZ));
      }
    }
    // Recomputing a cell is pure and cheap (spawn.ts), so a departed cell is simply dropped —
    // nothing to preserve, and walking back onto it rebuilds exactly the same school.
    for (const key of nearField.keys()) if (!wanted.has(key)) nearField.delete(key);
  }

  function manageRoamers(focus: { x: number; z: number }, t: number): void {
    // retire out-of-range active roamers to the dormant list instead of deleting them —
    // see spawn.ts's header for why this is what actually fixes "turning around re-rolls the reef"
    for (const [id, state] of roamers) {
      if (Math.hypot(state.cx - focus.x, state.cz - focus.z) > ROAM_RETIRE_R) {
        roamers.delete(id);
        dormant.set(id, { state, since: t });
      }
    }
    // drop dormant roamers whose TTL expired; reactivate the rest if back in range
    for (const [id, entry] of dormant) {
      if (t - entry.since > DORMANT_TTL_S) { dormant.delete(id); continue; }
      if (Math.hypot(entry.state.cx - focus.x, entry.state.cz - focus.z) <= ROAM_MAX_R) {
        roamers.set(id, entry.state);
        dormant.delete(id);
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
      roamers.set(state.id, state);
    }
  }

  const stats = {
    schools: 0, fish: 0, draws: 0,
    drawnFish: 0, culledDistance: 0, culledFrustum: 0,
    byTier: { impostor: 0, coarse: 0, low: 0, high: 0 } as Record<string, number>, triangles: 0,
    camX: 0, camY: 0, camZ: 0,
  };

  // The camera LOD/culling is evaluated against — see `setCamera`'s doc comment on the interface
  // for why this is not the same point as the population `focus`. Until the caller supplies one,
  // the view falls back to the focus point with an all-pass frustum, so a headless/test caller
  // that never calls setCamera still gets every fish submitted rather than none.
  let camera: THREE.Camera | null = null;
  const _frustum = new THREE.Frustum();
  const _viewProj = new THREE.Matrix4();
  const _camPos = new THREE.Vector3();
  const view: RenderView = { camX: 0, camY: 0, camZ: 0, frustum: _frustum };

  function setCamera(c: THREE.Camera): void { camera = c; }

  /** All-pass frustum: six planes pointing outward from a point at infinity, so
   * `intersectsSphere` is always true. Used when no camera has been supplied. */
  function setAllPassFrustum(): void {
    for (const p of _frustum.planes) p.set(new THREE.Vector3(0, 1, 0), Infinity);
  }

  function updateView(focus: { x: number; z: number }): void {
    if (camera) {
      camera.updateMatrixWorld();
      camera.getWorldPosition(_camPos);
      view.camX = _camPos.x; view.camY = _camPos.y; view.camZ = _camPos.z;
      const cam = camera as THREE.PerspectiveCamera;
      if (cam.projectionMatrix && cam.matrixWorldInverse) {
        _viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
        _frustum.setFromProjectionMatrix(_viewProj);
        return;
      }
    }
    view.camX = focus.x; view.camY = 0; view.camZ = focus.z;
    setAllPassFrustum();
  }

  function update(dt: number, t: number, focus: { x: number; z: number }, boat: Threat, extraThreats: Threat[] = []): void {
    swimClock.value = t;
    throttle -= dt;
    if (throttle <= 0) {
      throttle = SPAWN_THROTTLE_S;
      updateResidents(focus);
      updateNearField(focus);
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

    updateView(focus);

    const threats: Threat[] = [boatWithHeading, ...extraThreats];
    const ctx = { t, dt, threats };

    let fishCount = 0;
    const touched = new Set<SpeciesPool>();
    beginRenderStats();

    const runSchool = (state: SchoolState): void => {
      const pool = pools.get(state.type);
      if (!pool) return;
      const events = stepSchool(state, pool.V, ctx);
      for (const ev of events) if (ev.type === 'blow') { spoutSystem.spawn(ev.x, ev.y, ev.z); blowCount++; }
      if (!touched.has(pool)) { beginPoolFrame(pool); touched.add(pool); }
      renderSchool(state, pool, view);
      fishCount += state.members.length;
    };
    for (const state of residents.values()) runSchool(state);
    for (const state of nearField.values()) runSchool(state);
    for (const state of roamers.values()) runSchool(state);

    let draws = 0, triangles = 0;
    for (const pool of touched) {
      endPoolFrame(pool);
      for (const level of pool.levels.values()) {
        if (level.cursor === 0) continue;
        draws++;
        triangles += level.cursor * level.triPerInstance;
      }
    }
    spoutSystem.update(dt);

    stats.schools = residents.size + nearField.size + roamers.size;
    stats.fish = fishCount;
    stats.draws = draws;
    stats.drawnFish = renderStats.submitted;
    stats.culledDistance = renderStats.culledDistance;
    stats.culledFrustum = renderStats.culledFrustum;
    for (const k of Object.keys(stats.byTier)) stats.byTier[k] = renderStats.byTier[k] ?? 0;
    stats.triangles = triangles;
    stats.camX = view.camX; stats.camY = view.camY; stats.camZ = view.camZ;
  }

  /** Verification-only: the fish system's own draw-call/triangle contribution in isolation from
   * the rest of the scene, now broken out per LOD level — this is the number that shows the LOD
   * system working (a reef full of fish should be mostly `lod:2`/`lod:1` instances with only the
   * handful you are actually looking at closely in `lod:0`). `instances` is what was submitted on
   * the last completed frame, which is also exactly what the GPU drew. */
  function debugPoolStats(): Array<{ type: string; lod: string; triPerInstance: number; instances: number; capacity: number }> {
    const out: Array<{ type: string; lod: string; triPerInstance: number; instances: number; capacity: number }> = [];
    for (const pool of pools.values()) {
      for (const level of pool.levels.values()) {
        if (level.cursor === 0) continue;
        out.push({ type: pool.key, lod: level.lod, triPerInstance: level.triPerInstance, instances: level.cursor, capacity: level.capacity });
      }
    }
    return out;
  }

  function debugActiveSchools(): Array<{ id: string; type: string; cx: number; cz: number; heading: number; count: number; resident: boolean }> {
    const out: Array<{ id: string; type: string; cx: number; cz: number; heading: number; count: number; resident: boolean }> = [];
    for (const s of residents.values()) out.push({ id: s.id, type: s.type, cx: s.cx, cz: s.cz, heading: s.heading, count: s.members.length, resident: true });
    for (const s of nearField.values()) out.push({ id: s.id, type: s.type, cx: s.cx, cz: s.cz, heading: s.heading, count: s.members.length, resident: true });
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


  return { group, update, setCamera, stats, findResidentNear, waterColumnAt, debugActiveSchools, debugPoolStats, debugBlowCount };
}
