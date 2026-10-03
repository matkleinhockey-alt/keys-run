/**
 * Client-side wrapper around the shared, pure `stepDiver` (packages/shared/src/sim/diver.ts):
 * the `DiverEnv` the client feeds it every tick, built from world constants that already exist.
 *
 * SEAFLOOR INTEGRATION: sim/diver.ts's header anticipated a flat `-depthAt(x,z)` stand-in until
 * the real chunked LOD terrain landed (world/seafloor.ts, world/terrain/**). That terrain is now
 * in the game (see game/world.ts's boot sequence), so `defaultSeafloorSampler` reads the exact
 * same pure `seafloorHeightAt(x,z)` the terrain mesh itself samples per-vertex (world/terrain/
 * heightfield.ts) — the diver collides with what's actually rendered underfoot, reef ledges and
 * the wall's real drop included, not an earlier flat approximation of it. Still a one-method
 * `SeafloorSampler`, so nothing in sim/diver.ts needs to change.
 */
import { WB } from '@keysrun/shared/world/depth';
import type { DiverEnv, SeafloorSampler } from '@keysrun/shared/sim/diver';
import { seafloorHeightAt } from '../../world/seafloor.js';

/** Fixed physics step, matching game/world.ts's boat accumulator (docs/ARCHITECTURE.md requirement 2). */
export const DIVER_DT = 1 / 30;

export const defaultSeafloorSampler: SeafloorSampler = {
  heightAt(x: number, z: number): number {
    return seafloorHeightAt(x, z);
  },
};

export function makeDiverEnv(t: number, seafloor: SeafloorSampler = defaultSeafloorSampler): DiverEnv {
  return { t, seafloor, worldBounds: WB };
}
