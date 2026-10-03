/**
 * Sea floor: chunked LOD terrain over real bathymetry, replacing the legacy single 90k-vertex
 * plane this file used to build directly.
 *
 * docs/ARCHITECTURE.md flagged two problems with the old code: `floorY` crushed every depth past
 * 14 m to the same y≈-7.95 (so the reef wall — a real 3.4 m -> 45.4 m drop over 190 m, dz
 * 1460-1650 — rendered completely flat), and 28.6 m between vertices on one giant plane was too
 * coarse to show it even if it hadn't been crushed. The actual terrain is now chunked LOD mesh
 * built by ./terrain/{heightfield,chunk,lod}.ts; this file is just the public entry point.
 *
 * `floorY` is kept, now the identity, purely so world/coral.ts's existing `floorY(d)` call sites
 * keep compiling and automatically pick up real (uncrushed) depth with zero changes there — see
 * that file's header ("kept as-is per docs/ARCHITECTURE.md Phase 0 scope"). New code should call
 * `seafloorHeightAt(x,z)` instead, which is what the terrain mesh itself samples.
 */
import * as THREE from 'three';
import { createSeafloorManager } from './terrain/lod.js';

export { seafloorHeightAt, seafloorNormalAt } from './terrain/heightfield.js';

/** legacy `floorY` (index.html:708), now identity — depth is real, not crushed past 14 m. */
export const floorY = (d: number): number => -d;

export interface SeafloorHandles {
  group: THREE.Group;
  /**
   * Call once per frame with the camera's world position. Builds/frees 64 m terrain chunks
   * around it and (rarely) resamples the far horizon skirt. Safe — and intended — to call every
   * frame: the work itself is internally throttled (see ./terrain/lod.ts's header), never a full
   * rebuild.
   */
  update(cameraPos: THREE.Vector3): void;
  dispose(): void;
}

let activeManager: ReturnType<typeof createSeafloorManager> | null = null;

/**
 * True if the 64 m chunk containing world (x,z) is currently built and in the scene — i.e. the
 * terrain a caller would see or stand on there actually exists right now, at whatever LOD the
 * camera's distance currently gives it.
 *
 * For the reef system: don't scatter coral onto a chunk that isn't resident (wasted instances,
 * and they'd float over whatever placeholder is there instead — currently nothing, since chunks
 * outside the resident radius simply aren't rendered). For the diver's ground collision: a height
 * query for a chunk that hasn't streamed in yet is still well-defined (`seafloorHeightAt` is pure
 * math, no chunk required) but won't match anything on screen — check this first if that matters.
 *
 * Returns `true` if called before any `createSeafloor()` has run, so a caller that (incorrectly)
 * races init fails open rather than silently blocking everything.
 */
export function isSeafloorReady(x: number, z: number): boolean {
  return activeManager ? activeManager.isReady(x, z) : true;
}

/**
 * Builds the seafloor's scene graph and returns its handles. Chunking is entirely camera-
 * relative (see ./terrain/lod.ts) — unlike the old single plane, nothing here needs the world's
 * bounding rect up front.
 */
export function createSeafloor(): SeafloorHandles {
  const manager = createSeafloorManager();
  activeManager = manager;
  return { group: manager.group, update: manager.update, dispose: manager.dispose };
}
