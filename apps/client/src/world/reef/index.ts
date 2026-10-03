/**
 * Public entry point for the chunked reef system — see docs/ARCHITECTURE.md "Reef" and this
 * directory's other modules for the design. The only thing outside apps/client/src/world/reef/**
 * that needs to change to use this is game/world.ts: add `const reef = createReef();`,
 * `scene.add(reef.group);`, and call `reef.update(camera.position.x, camera.position.z)` once per
 * frame — see that file's "8. coral" step, which this replaces.
 */
import * as THREE from 'three';
import { createReefChunkManager, type ReefChunkManager } from './chunk-manager.js';

export interface Reef {
  group: THREE.Group;
  /** Call once per frame with the viewer's world (x,z) — cheap no-op unless the viewer has
   * crossed into a new 50 m chunk. Pass the *camera's* position, not necessarily the boat's: the
   * reef should build/free around whatever is actually being rendered (free-dive/diver camera,
   * once that lands, included) — see chunk-manager.ts's header. */
  update(x: number, z: number): void;
  dispose(): void;
  debugCounts: ReefChunkManager['debugCounts'];
}

export function createReef(): Reef {
  const manager = createReefChunkManager();
  return {
    group: manager.group,
    update: manager.update,
    dispose: manager.dispose,
    debugCounts: manager.debugCounts,
  };
}

export { CHUNK_SIZE, RESIDENT_CHUNK_RADIUS } from './constants.js';
export { diveSiteAt, type DiveSite } from './placement.js';
