/**
 * Client-side wrapper around the shared, pure `stepDiver` (packages/shared/src/sim/diver.ts):
 * the `DiverEnv` the client feeds it every tick, built from world constants that already exist.
 *
 * ⚠ SEAFLOOR INTEGRATION POINT (see sim/diver.ts's header): the seafloor agent is concurrently
 * building chunked LOD terrain that will expose a real `seafloorHeightAt(x,z)`. Until that
 * lands, `defaultSeafloorSampler` falls back to the existing bathymetry (`-depthAt(x,z)`) — a
 * flat bathymetric floor, not the real mesh, so a diver can clip through coral/ledges that sit
 * above the smooth depth curve. Swap the `heightAt` implementation below for the real sampler
 * behind the same one-method `SeafloorSampler` interface; nothing else (not `stepDiver`, not
 * this file's callers) needs to change.
 */
import { depthAt } from '@keysrun/shared/world/depth';
import { WB } from '@keysrun/shared/world/depth';
import type { DiverEnv, SeafloorSampler } from '@keysrun/shared/sim/diver';

/** Fixed physics step, matching game/world.ts's boat accumulator (docs/ARCHITECTURE.md requirement 2). */
export const DIVER_DT = 1 / 30;

export const defaultSeafloorSampler: SeafloorSampler = {
  heightAt(x: number, z: number): number {
    return -depthAt(x, z);
  },
};

export function makeDiverEnv(t: number, seafloor: SeafloorSampler = defaultSeafloorSampler): DiverEnv {
  return { t, seafloor, worldBounds: WB };
}
