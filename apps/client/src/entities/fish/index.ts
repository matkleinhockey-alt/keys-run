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
import { VIS, isCatchable } from '@keysrun/shared/content/creatures';
import { SPECIES } from '@keysrun/shared/content/species';
import { createSpeciesPool, beginPoolFrame, endPoolFrame, type SpeciesPool, type MeshReadyHook } from './pool.js';
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

/** Reused by `setAllPassFrustum` — a plane normal needs *a* direction; which one is irrelevant
 * when the constant is Infinity. */
const _UP = new THREE.Vector3(0, 1, 0);

const RESIDENT_RADIUS = 220;
const SPAWN_THROTTLE_S = 0.4; // legacy `popT` cadence (index.html:2542)
const ROAM_RETIRE_R = ROAM_MAX_R + 40; // legacy's `POP_R+40` free radius


/**
 * One real, individual spearable fish — the tier-3 tracked-fish registry docs/ARCHITECTURE.md's
 * "Fish ownership — three tiers" anticipates, scoped to what this single-player/no-server branch
 * needs: a real per-member capsule (not a per-school stand-in), a stable per-fish weight, and
 * `catchable` wired from `isCatchable` (never a species-name branch — see that field's own doc
 * comment). Deliberately shaped identically to `@keysrun/shared/sim/spear`'s `CapsuleTarget`
 * plus the `key`/`weight` fields `entities/speargun/index.ts`'s own `SpearTarget` adds on top
 * (`CapsuleTarget & { key: string; weight: number }`), so `game/world.ts`'s `getSpearTargets` can
 * hand these straight through with no remapping and nothing on the speargun side needs to change.
 */
export interface SpearTargetLite {
  id: string;
  key: string;
  weight: number;
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  radius: number;
  catchable: boolean;
  /** World-space velocity, m/s. Carried because `assistAim` (packages/shared/sim/spear.ts) gates
   * its entire lead calculation on it — `const vx = t.vx ?? 0 ... if (vx || vy || vz)` — so a
   * target with no velocity gets aimed at where it *is*, never where it will be. The shaft needs
   * ~0.2 s to cross 5 m, in which a 1.5 m/s reef fish moves most of its own body width, so
   * omitting this made the assist's lead silently dead code. */
  vx: number; vy: number; vz: number;
}

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
  /** The camera every LOD/cull decision is made against (render.ts). Separate from `focus` (the
   * *population* centre — the diver or the boat) because the two genuinely differ: in the chase
   * camera the eye sits metres behind the hull, and while diving the camera is at eye height
   * rather than at the diver's own origin. Call once per frame before `update`. */
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
    /** World position the LOD/cull decision was evaluated from this frame. Permanently useful: if
     * this ever diverges from where the viewer actually is, every fish culls at once. */
    camX: number; camY: number; camZ: number;
  };
  /** Individual spearable fish within `radius` of `(x,y,z)`, as real per-fish capsules built from
   * each member's own *live, already-rendered* `wx/wy/wz/yaw/pitch/roll/worldScale` transform
   * (the same numbers `render.ts` just wrote into the InstancedMesh this frame) — never
   * recomputed independently, so the capsule cannot drift from what is actually drawn. Culls by
   * school centroid first, then per-member, so this is cheap enough to call every frame while
   * diving — see `game/world.ts`'s `getSpearTargets`, the only real (non-test) caller. */
  spearTargetsNear(x: number, y: number, z: number, radius: number): SpearTargetLite[];
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
  /** Verification-only: every currently active school's centroid/type/member-count, plus its
   * live `flee` countdown (school.ts's `stepSchool` sets this to 1.5 the instant `nearestTrigger`
   * finds a threat, including a Problem-2 `'spear'` near-miss threat, then ticks it down to 0) —
   * `>0` is a direct, no-guessing signal that a school is actively spooked right now, used by
   * test/capture-spearable-fish.mjs to confirm a missed shot's flee response actually fired
   * instead of inferring it from position deltas. */
  debugActiveSchools(): Array<{ id: string; type: string; cx: number; cz: number; heading: number; count: number; resident: boolean; flee: number }>;
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

/** Deterministic string -> [0,1) (FNV-1a) — same family of hash `game/world.ts`'s now-removed
 * per-school stand-in used, kept local here rather than shared: it is five lines and the only two
 * places that ever needed "stable string -> unit float" are this file (per-fish weight) and that
 * one (which now just calls `spearTargetsNear` below), so a shared module would be pure ceremony. */
function hashUnit(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

/** How far outside a fish's own species-length a school's members can realistically sit (legacy
 * `spread`'s widest value is 10 for the biggest offshore pods, plus ~half the longest catchable
 * body — swordfish/blackmarlin ~3.6 m); used only to pre-cull whole schools by centroid distance
 * before `spearTargetsNear` touches their members — see that function. */
const SCHOOL_QUERY_MARGIN = 20;

/**
 * `onMeshReady` is handed each lazily-built per-(species, LOD) InstancedMesh so the caller can run
 * scene-level material setup on it — in practice `shadows.applyToSubtree`. Required because pool
 * levels materialise on first use, long after world.ts's one boot-time sweep; see pool.ts's
 * `MeshReadyHook`.
 */
export function createFishWorld(seed: number = WORLD_SEED, onMeshReady?: MeshReadyHook): FishWorld {
  const group = new THREE.Group();
  group.name = 'fish';

  const pools = new Map<string, SpeciesPool>();
  for (const [key, V] of Object.entries(VIS)) pools.set(key, createSpeciesPool(group, key, V, onMeshReady));

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
    byTier: { impostor: 0, coarse: 0, low: 0, high: 0 } as Record<string, number>,
    triangles: 0, camX: 0, camY: 0, camZ: 0,
  };

  // The camera LOD/culling is evaluated against — see `setCamera`'s doc comment on the interface
  // for why this is not the same point as the population `focus`. Until a caller supplies one the
  // view falls back to the focus point with an all-pass frustum, so a headless/test caller that
  // never calls setCamera still gets every fish submitted rather than none.
  let camera: THREE.Camera | null = null;
  const _frustum = new THREE.Frustum();
  const _viewProj = new THREE.Matrix4();
  const _camPos = new THREE.Vector3();
  const view: RenderView = { camX: 0, camY: 0, camZ: 0, frustum: _frustum };

  function setCamera(c: THREE.Camera): void { camera = c; }

  /** All-pass frustum: planes at infinity, so `intersectsSphere` is always true. */
  function setAllPassFrustum(): void {
    for (const p of _frustum.planes) p.set(_UP, Infinity);
  }

  function updateView(focus: { x: number; z: number }): void {
    if (camera) {
      camera.updateMatrixWorld();
      camera.getWorldPosition(_camPos);
      view.camX = _camPos.x; view.camY = _camPos.y; view.camZ = _camPos.z;
      const cam = camera as THREE.PerspectiveCamera;
      _viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_viewProj);
      return;
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

    const threats: Threat[] = [boatWithHeading, ...extraThreats];
    const ctx = { t, dt, threats };

    updateView(focus);

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
   * the rest of the (still fully topside-rendered, in this branch) scene — see pool.ts's
   * `mesh.count` high-water-mark doc comment for why `meshCount` (not `capacity`) is what actually
   * gets submitted to the GPU. */
  /** Verification-only: per-(species, LOD tier) draw/triangle accounting. This is the number that
   * shows the LOD system working — a busy reef should be mostly 'impostor'/'coarse'. */
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

  function debugActiveSchools(): Array<{ id: string; type: string; cx: number; cz: number; heading: number; count: number; resident: boolean; flee: number }> {
    const out: Array<{ id: string; type: string; cx: number; cz: number; heading: number; count: number; resident: boolean; flee: number }> = [];
    for (const s of residents.values()) out.push({ id: s.id, type: s.type, cx: s.cx, cz: s.cz, heading: s.heading, count: s.members.length, resident: true, flee: s.flee });
    for (const s of nearField.values()) out.push({ id: s.id, type: s.type, cx: s.cx, cz: s.cz, heading: s.heading, count: s.members.length, resident: true, flee: s.flee });
    for (const s of roamers.values()) out.push({ id: s.id, type: s.type, cx: s.cx, cz: s.cz, heading: s.heading, count: s.members.length, resident: false, flee: s.flee });
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

  /** Appends one `SpearTargetLite` per live member of `state` within `radius` of
   * `(originX,originY,originZ)` to `out` — the per-member half of `spearTargetsNear` below.
   * Skips species with no `SPECIES` weight/fight-table entry (ambient-only — e.g. angelfish;
   * mirrors the exact gate the old per-school stand-in in `game/world.ts` used) before touching
   * any member, so a school of a non-spearable species costs one map lookup, not N. */
  function pushSchoolTargets(
    state: SchoolState, originX: number, originY: number, originZ: number, radius: number, out: SpearTargetLite[],
  ): void {
    const S = SPECIES[state.type];
    if (!S) return;
    const V = VIS[state.type];
    if (!V) return;
    const catchable = isCatchable(state.type);
    const r2 = radius * radius;
    const Hh = V.h || V.len * 0.17, W = V.w || V.len * 0.16;
    // Spear hitbox, NOT the fish's true girth.
    //
    // The anatomically-correct half-girth is brutal as a target: a 0.42 m yellowtail is 0.12 m
    // tall and 0.07 m wide, giving a 6 cm capsule radius. Six centimetres, on a fish that is also
    // undulating (swim.ts bakes a per-vertex wiggle of up to 0.1x body length into the VAT, so the
    // drawn silhouette sways around this instance origin without the capsule knowing), shot from a
    // first-person gun that sways with the diver's breathing — it is essentially unhittable, which
    // is exactly the complaint.
    //
    // So: a forgiveness multiplier plus a floor. The floor is what rescues small schooling fish;
    // SPEAR_FORGIVENESS keeps big slow targets proportionally generous without making a goliath
    // grouper a barn door. This is a deliberate gameplay hitbox — hitboxes being larger than the
    // art is normal — and it is applied here, once, so both the shot test (sim/spear.ts's
    // stepSpear) and the aim assist agree on the same volume. They must: a reticle that locks onto
    // something the shaft then misses is worse than no assist at all.
    const SPEAR_MIN_RADIUS = 0.22;
    const SPEAR_FORGIVENESS = 1.45;
    const girthRadius = Math.max(SPEAR_MIN_RADIUS, Math.max(0.08, Math.max(Hh, W) / 2) * SPEAR_FORGIVENESS);
    for (let i = 0; i < state.members.length; i++) {
      const m = state.members[i];
      // NOTE: there used to be an `if (m.slot < 0) continue` here, meaning "skip members with no
      // render slot". That guard made spearfishing impossible.
      //
      // `FishMember.slot` dated from the original one-InstancedMesh-per-species pool, where a
      // member held an index into that mesh. The LOD rework replaced that scheme entirely —
      // render.ts now reads `m.wx/wy/wz` and pushes instances per LOD tier, with no slot
      // allocation anywhere — but it left the field on the type, still initialised to -1 in
      // spawn.ts (`slot: -1`) and never assigned again by anything. So the guard was not
      // "is this fish rendered", it was `-1 < 0`, i.e. `true`, for every fish in the world.
      // `spearTargetsNear` returned an empty array always; the gun had nothing to hit.
      //
      // The live set is simply `state.members`. A school that is active has members; render
      // culling is a per-frame display decision and must not determine what exists to be speared
      // — a fish at the edge of the frustum is still a fish.
      const dx = m.wx - originX, dy = m.wy - originY, dz = m.wz - originZ;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      // Body-axis capsule from this member's *own* live render transform (render.ts writes
      // exactly these fields onto the InstancedMesh this same frame — see this file's header on
      // `FishMember` and `spearTargetsNear`'s own doc comment): local -Z is the nose end
      // (body.ts's loft runs t=0 (head) at z=-L/2 to t=1 (tail) at z=+L/2), and for a 'YXZ' Euler
      // (pitch,yaw,roll) the world-space nose direction is the same forward-vector formula
      // `game/world.ts`'s diver aim/camera code already uses for the identical Euler order.
      const fwdX = -Math.sin(m.yaw) * Math.cos(m.pitch);
      const fwdY = Math.sin(m.pitch);
      const fwdZ = -Math.cos(m.yaw) * Math.cos(m.pitch);
      const half = (V.len * m.worldScale) / 2;
      const id = `${state.id}#${i}`;
      // Lead is DISABLED: `vx/vy/vz` are reported as zero, so `assistAim` skips its lead branch
      // and aims at the fish's current position.
      //
      // This is a measured decision, not an oversight. Three ways of supplying a velocity were
      // tried against a tracked yellowtail at 4-7 m:
      //
      //   no velocity (lead off)                  6/14  (43%)
      //   nose direction x species cruise speed   2/16  (13%)
      //   single-frame differencing of wx/wy/wz   2/16  (13%)
      //
      // Both lead attempts are far worse than none. The cruise-speed estimate overshoots because
      // a school member is orbiting a centroid and holding a formation offset rather than
      // travelling along its own facing. Frame differencing fails for a subtler reason: over one
      // frame the dominant term is the swim WIGGLE — a fast lateral oscillation about the fish's
      // path — not its net travel, so the derived vector points sideways and throws the shot off.
      // The measured magnitude was a suspiciously constant 1.93 m/s, which is that oscillation,
      // not progress through the water.
      //
      // A correct lead needs velocity low-passed over ~0.3 s so the wiggle averages out and net
      // travel survives. That means carrying smoothed per-member state through the sim rather
      // than deriving it in a query, which is a real change to the fish hot path and wants its
      // own pass. Until then, aiming true beats leading wrong.
      const vx = 0, vy = 0, vz = 0;
      out.push({
        id, key: state.type,
        // Stable for this fish's whole lifetime: derived from its identity (school id + member
        // index), never from anything that changes frame to frame — "a weight cannot change
        // mid-flight" (task brief). Resident schools' ids are chunk-derived (spawn.ts) so this is
        // also stable across sessions; roamer ids are a per-process counter (spawn.ts's
        // `roamCounter`), stable only within one running client, same pre-existing limitation the
        // old per-school stand-in had.
        weight: S.min + (S.max - S.min) * hashUnit(id),
        ax: m.wx + fwdX * half, ay: m.wy + fwdY * half, az: m.wz + fwdZ * half,
        bx: m.wx - fwdX * half, by: m.wy - fwdY * half, bz: m.wz - fwdZ * half,
        radius: girthRadius * m.worldScale,
        vx, vy, vz,
        catchable,
      });
    }
  }

  function spearTargetsNear(x: number, y: number, z: number, radius: number): SpearTargetLite[] {
    const out: SpearTargetLite[] = [];
    const schoolR2 = (radius + SCHOOL_QUERY_MARGIN) * (radius + SCHOOL_QUERY_MARGIN);
    for (const state of residents.values()) {
      const dx = state.cx - x, dz = state.cz - z;
      if (dx * dx + dz * dz > schoolR2) continue;
      pushSchoolTargets(state, x, y, z, radius, out);
    }
    for (const state of roamers.values()) {
      const dx = state.cx - x, dz = state.cz - z;
      if (dx * dx + dz * dz > schoolR2) continue;
      pushSchoolTargets(state, x, y, z, radius, out);
    }
    return out;
  }

  return {
    group, update, setCamera, stats, spearTargetsNear,
    findResidentNear, waterColumnAt, debugActiveSchools, debugPoolStats, debugBlowCount,
  };
}
