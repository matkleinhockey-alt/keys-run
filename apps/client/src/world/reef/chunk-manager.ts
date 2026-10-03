/**
 * Chunk residency + InstancedMesh pooling. "Only a 5x5 chunk neighbourhood is ever resident.
 * Build/free as the camera moves; never rebuild per frame." (docs/ARCHITECTURE.md "Reef").
 *
 * Design: one fixed-capacity InstancedMesh per (species, LOD) — up to 10 species x 3 LOD = 30
 * draw calls total — allocated ONCE at startup, sized to the worst case (every resident chunk
 * simultaneously maxed out for that species, all landing in one LOD bucket). A rebuild only
 * rewrites that pool's buffers and sets `.count`; it never creates or destroys a THREE object,
 * so there is nothing to dispose and nothing to leak as the camera roams for a long session —
 * simpler and cheaper than recreating meshes on every chunk crossing.
 *
 * A rebuild runs only when the camera's own chunk coordinate changes (i.e. roughly every 50 m of
 * travel), not every frame. LOD is assigned from each instance's distance to the camera's real
 * (x,z) *as of that rebuild* (see `rebuild`'s own comment for why a chunk-center point is the
 * wrong reference) — stable between rebuilds since it's only recomputed on a chunk crossing, but
 * accurate to where the camera actually is at that moment. See constants.ts's header on
 * LOD_NEAR_MAX/LOD_MID_MAX for why this (not `scene.fog`) is the right distance reference here.
 */
import * as THREE from 'three';
import { RESIDENT_CHUNK_RADIUS, LOD_NEAR_MAX, LOD_MID_MAX, CANDIDATES_PER_CHUNK } from './constants.js';
import { geometryFor } from './geometry.js';
import { materialFor, type MaterialStyle } from './materials.js';
import { placeChunk, worldToChunk } from './placement.js';
import { SPECIES, SPECIES_LIST } from './species.js';
import type { ChunkCoord, ChunkPlacement, Lod, ReefInstance, SpeciesId } from './types.js';

const RESIDENT_SIDE = RESIDENT_CHUNK_RADIUS * 2 + 1;
const RESIDENT_CHUNK_COUNT = RESIDENT_SIDE * RESIDENT_SIDE;

/** Base material style per species (near/mid tier) — see materials.ts and geometry.ts's header
 * for why fans/plumes/seagrass are "card" at every tier while sponges stay "solid" at every
 * tier. */
const BASE_STYLE: Record<SpeciesId, MaterialStyle> = {
  elkhorn: 'solid', staghorn: 'solid', brain: 'solid', star: 'solid', encrusting: 'solid',
  barrelSponge: 'solid', tubeSponge: 'solid',
  seaFan: 'card', seaPlume: 'card', seagrass: 'card',
};

/** Species whose *far* LOD switches to a cheap card even though near/mid are solid geometry —
 * the "billboard/impostor far" tier for the volumetric branching corals. */
const FAR_SWITCHES_TO_CARD: ReadonlySet<SpeciesId> = new Set(['elkhorn', 'staghorn']);

interface Pool {
  mesh: THREE.InstancedMesh;
  capacity: number;
}

const LODS: Lod[] = ['near', 'mid', 'far'];

function styleFor(species: SpeciesId, lod: Lod): MaterialStyle {
  if (lod === 'far' && FAR_SWITCHES_TO_CARD.has(species)) return 'card';
  return BASE_STYLE[species];
}

export interface ReefChunkManager {
  group: THREE.Group;
  /** Call once per frame with the viewer's world position (camera, not necessarily the boat —
   * see game/world.ts's wiring note). No-ops unless the viewer has crossed into a new chunk. */
  update(x: number, z: number): void;
  dispose(): void;
  /** For the verification harness/profiler read-back only. */
  debugCounts(): { residentChunks: number; instancesBySpecies: Record<SpeciesId, number> };
}

export function createReefChunkManager(): ReefChunkManager {
  const group = new THREE.Group();
  group.name = 'reef';

  const pools = new Map<string, Pool>();
  const overflowWarned = new Set<string>();
  const dummy = new THREE.Object3D();
  const colA = new THREE.Color();
  const colB = new THREE.Color();

  for (const species of SPECIES_LIST) {
    const capacity = CANDIDATES_PER_CHUNK[species.id] * RESIDENT_CHUNK_COUNT;
    const geoSet = geometryFor(species.id);
    for (const lod of LODS) {
      const key = `${species.id}:${lod}`;
      const material = materialFor(species, styleFor(species.id, lod));
      const mesh = new THREE.InstancedMesh(geoSet[lod], material, capacity);
      mesh.count = 0;
      mesh.frustumCulled = false; // the chunk manager itself is the culling system here
      group.add(mesh);
      pools.set(key, { mesh, capacity });
    }
  }

  // Placement is a pure function of (cx,cz) — cache it so re-entering a chunk doesn't recompute,
  // but cap the cache so a long session spent roaming the whole reef doesn't grow it forever.
  const chunkCache = new Map<string, Partial<ChunkPlacement>>();
  const CACHE_LIMIT = 900; // ~30x30 chunks = 1.5 km square of history; generous but bounded

  function getPlacement(cx: number, cz: number): Partial<ChunkPlacement> {
    const key = `${cx}:${cz}`;
    let p = chunkCache.get(key);
    if (!p) {
      p = placeChunk(cx, cz);
      chunkCache.set(key, p);
      if (chunkCache.size > CACHE_LIMIT) {
        const first = chunkCache.keys().next();
        if (!first.done) chunkCache.delete(first.value);
      }
    }
    return p;
  }

  let lastCamChunk: ChunkCoord | null = null;

  // LOD distance reference is the camera's real (x,z) *at the moment of the last rebuild* — not
  // an abstract chunk-center point, which (with a 50 m chunk) can sit up to ~35 m from where the
  // camera actually is and would push nearly everything into "mid"/"far" regardless of true
  // proximity. Still only updates on a chunk-crossing rebuild, never per frame, which is the
  // property that actually matters for "never rebuild per frame".
  function rebuild(camChunk: ChunkCoord, camX: number, camZ: number): void {
    const buckets: Record<SpeciesId, Record<Lod, ReefInstance[]>> = {} as Record<SpeciesId, Record<Lod, ReefInstance[]>>;
    for (const species of SPECIES_LIST) buckets[species.id] = { near: [], mid: [], far: [] };

    for (let dx = -RESIDENT_CHUNK_RADIUS; dx <= RESIDENT_CHUNK_RADIUS; dx++) {
      for (let dz = -RESIDENT_CHUNK_RADIUS; dz <= RESIDENT_CHUNK_RADIUS; dz++) {
        const placement = getPlacement(camChunk.cx + dx, camChunk.cz + dz);
        for (const species of SPECIES_LIST) {
          const list = placement[species.id];
          if (!list) continue;
          for (const inst of list) {
            const dist = Math.hypot(inst.x - camX, inst.z - camZ);
            const lod: Lod = dist < LOD_NEAR_MAX ? 'near' : dist < LOD_MID_MAX ? 'mid' : 'far';
            buckets[species.id][lod].push(inst);
          }
        }
      }
    }

    for (const species of SPECIES_LIST) {
      const def = SPECIES[species.id];
      for (const lod of LODS) {
        const key = `${species.id}:${lod}`;
        const pool = pools.get(key);
        if (!pool) continue;
        let instances = buckets[species.id][lod];
        if (instances.length > pool.capacity) {
          if (!overflowWarned.has(key)) {
            overflowWarned.add(key);
            console.warn(`reef: ${key} exceeded its pool capacity (${instances.length} > ${pool.capacity}); truncating. Raise CANDIDATES_PER_CHUNK or widen the LOD bands.`);
          }
          instances = instances.slice(0, pool.capacity);
        }
        const { mesh } = pool;
        for (let i = 0; i < instances.length; i++) {
          const inst = instances[i];
          dummy.position.set(inst.x, inst.y, inst.z);
          dummy.rotation.set(inst.tiltX, inst.rotY, inst.tiltZ);
          dummy.scale.set(inst.scaleX, inst.scaleY, inst.scaleZ);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
          colA.set(def.colorLo); colB.set(def.colorHi);
          mesh.setColorAt(i, colA.lerp(colB, inst.colorT));
        }
        mesh.count = instances.length;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
  }

  function update(x: number, z: number): void {
    const camChunk = worldToChunk(x, z);
    if (lastCamChunk && lastCamChunk.cx === camChunk.cx && lastCamChunk.cz === camChunk.cz) return;
    lastCamChunk = camChunk;
    rebuild(camChunk, x, z);
  }

  function dispose(): void {
    // Geometry/materials are module-level caches shared across every reef instance for the life
    // of the app (same convention as core/textures.ts's texture caches) — dispose() here only
    // detaches this manager's meshes from the scene graph, it doesn't tear down those caches.
    for (const { mesh } of pools.values()) group.remove(mesh);
    pools.clear();
    chunkCache.clear();
  }

  function debugCounts(): { residentChunks: number; instancesBySpecies: Record<SpeciesId, number> } {
    const instancesBySpecies = {} as Record<SpeciesId, number>;
    for (const species of SPECIES_LIST) {
      let n = 0;
      for (const lod of LODS) n += pools.get(`${species.id}:${lod}`)?.mesh.count ?? 0;
      instancesBySpecies[species.id] = n;
    }
    return { residentChunks: RESIDENT_CHUNK_COUNT, instancesBySpecies };
  }

  return { group, update, dispose, debugCounts };
}
