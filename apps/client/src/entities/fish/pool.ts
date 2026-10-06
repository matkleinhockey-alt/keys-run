/**
 * Per-species, per-LOD instanced-mesh pool.
 *
 * Replaces the original "one `InstancedMesh` per species, stable slot handed out at spawn and
 * held until retire" design (legacy's `VGEO`/`VMESH`/`VFREE`, index.html:2478-2486). Two things
 * forced the change, both from docs/ARCHITECTURE.md's performance budget and the brief's "use a
 * Level of Depth system ... leave most of the vert capacity to the up-close experience":
 *
 *  1. **A stable slot cannot change LOD.** If instance 7 of the yellowtail mesh is "that
 *     particular fish" for its whole life, then that fish is stuck at whatever detail the mesh
 *     was built with, at every distance. Measured before this change: every fish was ~1,800
 *     triangles whether it was 2 m or 300 m away, `frustumCulled` was off, and there was no
 *     distance cull at all — 60 fish cost ~150k triangles.
 *  2. **Density had to go up by more than an order of magnitude** (see spawn.ts's near-field
 *     layer) for a reef to read as alive inside a 20-25 m visibility sphere. At the old cost that
 *     was ~3M triangles on fish alone, against a 2.5M whole-scene budget.
 *
 * So instances are now assigned **per frame, by apparent size**: `render.ts` walks the live
 * members, computes each one's LOD from `len/distance` (not raw distance — see `lodFor`, and the
 * brief's "load only big assets in the distance"), and appends its matrix to that LOD's mesh at a
 * write cursor that resets every frame. Nothing is allocated or freed per fish; a school
 * activating is now free, and overflow degrades gracefully (the surplus simply isn't drawn this
 * frame) instead of refusing to spawn the school.
 *
 * **Levels are built lazily.** Three LODs x 49 species is 147 geometry builds + 147 VAT bakes,
 * which is a boot-time cost worth avoiding when a given dive only ever touches a dozen species.
 * A level materialises on its first `pushInstance`; species the player never swims near cost
 * nothing. This makes boot *cheaper* than the eager single-LOD version it replaces.
 */
import * as THREE from 'three';
import type { CreatureVis } from '@keysrun/shared/content/creatures';
import { buildCreatureGeo } from './geometry.js';
import type { FishDetail } from './body.js';
import { computeSwimProfile } from './swim.js';
import { bakeVAT, attachVertexIndex, DEFAULT_VAT_FRAMES, type VatBake } from './vat.js';
import { createFishMaterial } from './materials.js';

/**
 * LOD thresholds, expressed as **apparent size** — world length divided by distance to camera,
 * which is (to small-angle) the fraction of the viewport the fish spans. Using apparent size
 * rather than raw distance is the whole point of the brief's "load only big assets in the
 * distance": at `LOD0_APPARENT` a 40 cm yellowtail drops to mid detail about 9 m away, while a
 * 15 m humpback holds full detail out to ~330 m. The big fish — "the MAIN star of the show" —
 * keep their silhouette and their triangles exactly where you can still see them, and the small
 * stuff spends nothing at range.
 */
export const LOD0_APPARENT = 0.045;
export const LOD1_APPARENT = 0.012;
/** Below this the fish is well under a pixel; skip it entirely rather than draw a degenerate
 * triangle fan. A 40 cm fish culls at ~160 m, a 15 m whale not until ~6 km (i.e. never, inside
 * the 1,900 m topside fog). */
export const CULL_APPARENT = 0.0025;

/** Apparent-size bucket for one fish. `worldLen` is the species length times the instance's own
 * scale, so an undersized juvenile correctly drops a level before a full-grown adult does. */
export function lodFor(worldLen: number, dist: number): FishDetail | null {
  const a = worldLen / Math.max(dist, 0.001);
  if (a < CULL_APPARENT) return null;
  if (a >= LOD0_APPARENT) return 'low';
  if (a >= LOD1_APPARENT) return 'coarse';
  return 'impostor';
}

/** The three tiers render.ts can hand to `pushInstance`, coarsest first. `'high'` is deliberately
 * absent: it is the catch-portrait tier (one fish, filling the screen), never a school fish. */
export const SCHOOL_TIERS: readonly FishDetail[] = ['impostor', 'coarse', 'low'];

/** Coarser VAT bakes for coarser geometry — a 7x6 body loft has nothing like the spatial
 * frequency that needs 24 distinct swim frames to read smoothly, and the texture is
 * `vertexCount x frameCount` floats, so this compounds with the vertex reduction. */
const VAT_FRAMES: Record<FishDetail, number> = { low: DEFAULT_VAT_FRAMES, high: DEFAULT_VAT_FRAMES, coarse: 16, impostor: 8 };

/** Instance capacity a level starts at, and the ceiling it may grow to. Growth is x2 on overflow
 * (see `pushInstance`); starting small keeps the per-level typed arrays cheap for the long tail
 * of species that only ever show up as a lone individual. */
const INITIAL_CAPACITY = 64;
const MAX_CAPACITY = 4096;

export interface LodLevel {
  lod: FishDetail;
  mesh: THREE.InstancedMesh;
  vat: VatBake;
  geo: THREE.BufferGeometry;
  mat: THREE.MeshPhysicalMaterial;
  capacity: number;
  /** Instances written so far this frame. Reset by `beginPoolFrame`, published to `mesh.count`
   * by `endPoolFrame`. */
  cursor: number;
  attached: boolean;
  triPerInstance: number;
}

/**
 * Called with each newly built LOD mesh, right after it is created and before it is first drawn.
 *
 * This exists because levels are built **lazily** (see this module's header). `world.ts` runs
 * `shadows.applyToSubtree(scene)` once at boot to give every material in the scene its cascaded-
 * shadow setup; a fish material that does not exist yet at that moment is simply never visited,
 * and renders with a shader that does not match the CSM-lit scene around it. At `quality: low`
 * shadows are off and nothing goes wrong, which is exactly why this survived verification —
 * every measurement had been taken at `low`.
 *
 * `entities/crew-model` has the same problem for the same reason (its glTF arrives after boot)
 * and solves it the same way; see `world.ts`'s `createCrewSystem(..., group => applyToSubtree)`.
 */
export type MeshReadyHook = (
  mesh: THREE.InstancedMesh,
  material: THREE.MeshPhysicalMaterial,
  baseOnBeforeCompile: NonNullable<THREE.MeshPhysicalMaterial['onBeforeCompile']>,
) => void;

export interface SpeciesPool {
  key: string;
  V: CreatureVis;
  group: THREE.Group;
  /** See `MeshReadyHook`. */
  onMeshReady?: MeshReadyHook;
  /** Keyed by tier, populated lazily — a tier materialises on its first `pushInstance`. */
  levels: Map<FishDetail, LodLevel>;
  /** Instances submitted last completed frame, summed across levels (stats/verification only). */
  live: number;
  /** Instances dropped last frame because a level was at `MAX_CAPACITY` (stats/verification). */
  dropped: number;
}

export function createSpeciesPool(group: THREE.Group, key: string, V: CreatureVis, onMeshReady?: MeshReadyHook): SpeciesPool {
  // Nothing is built here any more — see this module's header on lazy levels.
  return { key, V, group, onMeshReady, levels: new Map(), live: 0, dropped: 0 };
}

function buildLevel(pool: SpeciesPool, lod: FishDetail, capacity: number): LodLevel {
  const geo = buildCreatureGeo(pool.key, pool.V, lod);
  attachVertexIndex(geo);
  const profile = computeSwimProfile(geo, pool.key, pool.V);
  const vat = bakeVAT(profile, VAT_FRAMES[lod]);
  const { material: mat, baseOnBeforeCompile } = createFishMaterial(pool.key, pool.V, vat, profile.uScl, profile.uShn);
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  // Instance matrices are rewritten from scratch every frame (see this module's header), so the
  // buffer is genuinely dynamic. Per-instance frustum culling happens on the CPU in render.ts —
  // an InstancedMesh's own bounding volume would have to cover every instance's spread, which for
  // a school straddling the camera is the whole visible world, so three's culling can never
  // reject it and only costs a bounding-sphere recompute to say so.
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = false; // underwater draw distance is ~25 m and fish are small
  mesh.count = 0;
  mesh.name = `fish:${pool.key}:lod${lod}`;
  mesh.renderOrder = 0;

  const iPhase = new Float32Array(capacity);
  const attr = new THREE.InstancedBufferAttribute(iPhase, 1);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPhase', attr);

  const idx = geo.index;
  const triPerInstance = idx ? idx.count / 3 : geo.attributes.position.count / 3;
  // Hand the brand-new mesh to the scene-level material setup before anything draws it. The base
  // compile goes with it because CSM must re-wrap from that, not clobber it — see materials.ts's
  // `FishMaterial` and core/shadows.ts's header.
  pool.onMeshReady?.(mesh, mat, baseOnBeforeCompile);
  return { lod, mesh, vat, geo, mat, capacity, cursor: 0, attached: false, triPerInstance };
}

/** Grows a level in place to `capacity`, preserving geometry/material/VAT (only the instance
 * buffers are re-sized, so no geometry rebuild and no VAT re-bake). */
function growLevel(pool: SpeciesPool, level: LodLevel, capacity: number): LodLevel {
  const wasAttached = level.attached;
  if (wasAttached) pool.group.remove(level.mesh);
  level.mesh.dispose();

  const mesh = new THREE.InstancedMesh(level.geo, level.mat, capacity);
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = false;
  mesh.count = 0;
  mesh.name = level.mesh.name;

  const attr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
  attr.setUsage(THREE.DynamicDrawUsage);
  level.geo.setAttribute('iPhase', attr);

  level.mesh = mesh;
  level.capacity = capacity;
  level.attached = false;
  if (wasAttached) { pool.group.add(mesh); level.attached = true; }
  return level;
}

/** Resets every built level's write cursor. Call once per frame, before any `pushInstance`. */
export function beginPoolFrame(pool: SpeciesPool): void {
  pool.live = 0;
  pool.dropped = 0;
  for (const level of pool.levels.values()) level.cursor = 0;
}

const _m = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();

/**
 * Appends one fish to `lod`'s instance buffer for this frame. Returns false only when the level
 * is already at `MAX_CAPACITY` — a soft, graceful drop (that one fish isn't drawn this frame),
 * never a spawn refusal.
 */
export function pushInstance(
  pool: SpeciesPool, lod: FishDetail,
  x: number, y: number, z: number,
  yaw: number, pitch: number, roll: number,
  scale: number, swimPhase: number,
): boolean {
  let level = pool.levels.get(lod);
  if (!level) { level = buildLevel(pool, lod, INITIAL_CAPACITY); pool.levels.set(lod, level); }
  if (level.cursor >= level.capacity) {
    if (level.capacity >= MAX_CAPACITY) { pool.dropped++; return false; }
    level = growLevel(pool, level, Math.min(MAX_CAPACITY, level.capacity * 2));
    pool.levels.set(lod, level);
  }
  const i = level.cursor++;
  // Same rotation convention render.ts's predecessor used via Object3D ('YXZ' euler order).
  _m.compose(_pos.set(x, y, z), _quat.setFromEuler(_euler.set(pitch, yaw, roll, 'YXZ')), _scl.setScalar(scale));
  level.mesh.setMatrixAt(i, _m);
  (level.geo.attributes.iPhase as THREE.InstancedBufferAttribute).setX(i, swimPhase);
  return true;
}

/**
 * Publishes this frame's cursors as draw counts and attaches/detaches each level from the scene
 * graph. A level with nothing in it this frame is removed outright rather than drawn with
 * `count = 0`, so an empty species costs zero draw calls — which is what keeps the per-species,
 * per-LOD split inside docs/ARCHITECTURE.md's "< 300 draw calls underwater" budget even though
 * the mesh *count* tripled.
 */
export function endPoolFrame(pool: SpeciesPool): void {
  for (const level of pool.levels.values()) {
    const n = level.cursor;
    level.mesh.count = n;
    if (n > 0) {
      level.mesh.instanceMatrix.needsUpdate = true;
      (level.geo.attributes.iPhase as THREE.InstancedBufferAttribute).needsUpdate = true;
      if (!level.attached) { pool.group.add(level.mesh); level.attached = true; }
      pool.live += n;
    } else if (level.attached) {
      pool.group.remove(level.mesh);
      level.attached = false;
    }
  }
}
