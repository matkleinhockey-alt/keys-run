/**
 * Tunables for the chunked reef system. See docs/ARCHITECTURE.md "Reef":
 * "50 m chunks, per-coral-type InstancedMesh with per-instance transform/colour, placed
 * deterministically from hashCell... Underwater draw distance is ~25 m, so only a 5x5
 * neighbourhood is ever resident."
 */

import type { SpeciesId } from './types.js';

/** This module's own world seed. Deliberately a separate constant from client state's
 * `WORLD_SEED` (apps/client/src/state/constants.ts) even though both currently hold the same
 * literal — reef placement is owned entirely by this directory (see the task's ownership
 * boundary) and must never need an edit to a file outside it merely to change its own seed. */
export const REEF_WORLD_SEED = 20240817;

export const CHUNK_SIZE = 50; // metres
/** 5x5 neighbourhood = radius 2 chunks around the camera's own chunk. */
export const RESIDENT_CHUNK_RADIUS = 2;

/** Distance (metres, instance-to-camera-chunk-center — see chunk-manager.ts) below which an
 * instance gets full-detail "near" geometry; below LOD_MID_MAX gets "mid"; beyond that, "far"
 * (impostor). Chosen against the underwater visibility table in docs/ARCHITECTURE.md ("The
 * underwater world": 10-25 m depending on band), not against `scene.fog`, which today is still
 * tuned for the 260-1750 m topside view — the underwater per-channel-extinction fog override is
 * a different agent's deliverable (world/underwater/**); this module must not depend on it. */
export const LOD_NEAR_MAX = 14;
export const LOD_MID_MAX = 26;

/** Fixed per-species, per-attribute hash salts — see types.ts's header and the "Determinism"
 * section of docs/ARCHITECTURE.md ("position-derived, not iteration-order-derived"). `saltBase`
 * is a hardcoded literal per species (spaced far enough apart that folding in attribute index and
 * candidate slot can never collide with the next species' range), never computed from the
 * species' position in SPECIES_LIST — so reordering or adding to that list cannot change any
 * existing species' hash stream. Within one species, `salt = saltBase + attr*4096 + slot`:
 * `attr` is a small fixed enum (see `Attr` below) and `slot` is the candidate's own index within
 * its chunk — never a running/shared counter. */
export const SALT_BASE: Record<SpeciesId, number> = {
  elkhorn: 1_000_000,
  staghorn: 2_000_000,
  brain: 3_000_000,
  star: 4_000_000,
  seaFan: 5_000_000,
  seaPlume: 6_000_000,
  barrelSponge: 7_000_000,
  tubeSponge: 8_000_000,
  encrusting: 9_000_000,
  seagrass: 10_000_000,
};

/** Non-species-specific salts (dive-site dressing, micro-patch roll, sand channels) — also fixed
 * literals, far outside every species' saltBase range above. */
export const WORLD_SALT = {
  MICRO_PATCH_PRESENT: 20_000_001,
};

export const Attr = {
  PRESENCE: 0, OFFSET_X: 1, OFFSET_Z: 2, ROT_Y: 3, SCALE: 4, COLOR: 5, TILT_X: 6, TILT_Z: 7,
  SCALE_X: 8, SCALE_Y: 9, SCALE_Z: 10,
} as const;

/** How many slot values one attribute's range reserves — must exceed the largest per-chunk
 * candidate count used anywhere below (the densest is seagrass at 140). */
export const SLOTS_PER_ATTR = 4096;

export function foldSalt(speciesOrBase: SpeciesId | number, attr: number, slot: number): number {
  const base = typeof speciesOrBase === 'number' ? speciesOrBase : SALT_BASE[speciesOrBase];
  return base + attr * SLOTS_PER_ATTR + slot;
}

/** Candidate slots tried per chunk per species — a fixed ceiling, not a "how many exist" count;
 * most candidates are rejected by `species.ts`'s suitability function. Numbers are tuned to the
 * measured draw-call/triangle budget in this module's report: the first pass (22/26/14/14/...)
 * measured a peak of 25 draw calls and ~15.5k reef-only triangles against a budget of <300 calls
 * and <2.5M triangles — under 1% of the triangle budget and a flat 30-pool draw-call count that
 * density can't move at all (every species is one InstancedMesh per LOD regardless of instance
 * count). That headroom was itself making the reef read sparse/"scattered blobs" rather than a
 * reef, so this pass raises every non-seagrass count ~2.2-2.5x (seagrass was already dense and
 * stays put) and re-measures in the same report — still comfortably inside budget. */
export const CANDIDATES_PER_CHUNK: Record<SpeciesId, number> = {
  elkhorn: 50,
  staghorn: 60,
  brain: 32,
  star: 32,
  seaFan: 46,
  seaPlume: 36,
  barrelSponge: 16,
  tubeSponge: 16,
  encrusting: 40,
  seagrass: 140,
};

/** Real Sombrero Reef Light sits at x=250 per world/landmarks.ts and the legacy chart label
 * (`['Sombrero Reef',250,chainZ(250)+1340]`) — reused here as a plain literal (not imported; this
 * module owns no dependency on world/landmarks.ts) so the reef's "dressed" crest lines up with the
 * lighthouse players actually see. */
export const SOMBRERO_ANCHOR_X = 250;
export const SOMBRERO_ANCHOR_DZ = 1380;
export const SOMBRERO_RADIUS = 380;
/** Spur-and-groove groove spacing along the chain (metres) — Sombrero's real, famous geomorphology:
 * parallel sand grooves running cross-shore, separating coral spurs. */
export const SOMBRERO_GROOVE_PERIOD = 34;

export const MICRO_PATCH_PROBABILITY = 0.07;
export const PATCH_REEF_FULL_RADIUS = 60;
export const PATCH_REEF_FADE_RADIUS = 110;
