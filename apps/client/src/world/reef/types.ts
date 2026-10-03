/**
 * Shared types for the chunked reef system. See docs/ARCHITECTURE.md "Reef" and "The underwater
 * world" (depth bands) — this module owns apps/client/src/world/reef/**.
 *
 * `placement.ts` is kept three.js-free (plain data in, plain data out) so it can be unit-tested
 * under `vitest run` without a WebGL context, and so the determinism contract — "same seed + same
 * chunk coords -> byte-identical placement" — is a property of pure functions, not of anything
 * that touches a renderer.
 */

/** One of the ten reef species this module places and renders. Each is its own fixed, literal
 * `saltBase` (see constants.ts) — never derived from array index/position — so adding a new
 * species later can never shift any existing species' hash stream. */
export type SpeciesId =
  | 'elkhorn'
  | 'staghorn'
  | 'brain'
  | 'star'
  | 'seaFan'
  | 'seaPlume'
  | 'barrelSponge'
  | 'tubeSponge'
  | 'encrusting'
  | 'seagrass';

/** LOD tier assigned at chunk-build time from distance-to-camera-chunk-center (see
 * chunk-manager.ts) — "full geometry near, simplified mid, billboard/impostor far". */
export type Lod = 'near' | 'mid' | 'far';

/** One placed instance: plain numbers only, no THREE.* types (see header). `y` is the terrain
 * contact height in world space — see terrain.ts's `reefGroundY` integration-point note. */
export interface ReefInstance {
  species: SpeciesId;
  x: number;
  y: number;
  z: number;
  rotY: number;
  tiltX: number;
  tiltZ: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  /** 0..1, fed through each species' colour ramp — see species.ts. */
  colorT: number;
}

export interface ChunkCoord {
  cx: number;
  cz: number;
}

/** Per-chunk placement result, keyed by species so the chunk manager can bucket straight into
 * per-(species, LOD) InstancedMesh pools without re-filtering. */
export type ChunkPlacement = Record<SpeciesId, ReefInstance[]>;
