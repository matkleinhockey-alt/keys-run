/**
 * Reef ecology: which of the ten species belongs at a given depth, and how it's coloured.
 *
 * Depth bands are tuned against docs/ARCHITECTURE.md's underwater table and real Marathon/Keys
 * reef biology (NOAA Florida Keys National Marine Sanctuary species accounts): elkhorn on the
 * shallow, wave-exposed crest; staghorn mid-slope; massive brain/star corals and sponges deeper
 * on the wall; gorgonians (sea fans/plumes) spanning mid-to-deep; seagrass restricted to the
 * shallow flats, nowhere near the reef.
 *
 * Pure (no three.js) — consumed by placement.ts (also pure) and by geometry.ts (which turns a
 * `colorT` into an actual THREE.Color).
 */
import type { SpeciesId } from './types.js';

/** Trapezoidal depth-suitability membership: 0 outside [loStart,hiEnd], ramps linearly up to 1
 * across [loStart,loFull], flat 1 across [loFull,hiFull], ramps back down across [hiFull,hiEnd]. */
export function trapezoid(d: number, loStart: number, loFull: number, hiFull: number, hiEnd: number): number {
  if (d <= loStart || d >= hiEnd) return 0;
  if (d < loFull) return (d - loStart) / (loFull - loStart);
  if (d <= hiFull) return 1;
  return (hiEnd - d) / (hiEnd - hiFull);
}

export interface SpeciesDef {
  id: SpeciesId;
  /** True for every true reef/hardbottom organism; false only for seagrass, which is explicitly
   * "on the shallow flats, not on the reef" (docs/ARCHITECTURE.md). Gates which zone test
   * placement.ts runs. */
  reefAssociated: boolean;
  depth: [number, number, number, number]; // trapezoid(loStart, loFull, hiFull, hiEnd)
  /** Two colours lerped by each instance's own `colorT` for natural variation within a species —
   * same idea as the legacy coral palette array, but per-species rather than one shared list. */
  colorLo: number;
  colorHi: number;
  scale: [number, number]; // min/max uniform-ish scale multiplier
  /** Roughly how tall/wide at scale=1, in metres — used by placement.ts to keep neighbours from
   * fully overlapping and by chunk-manager.ts to size instance capacity headroom. */
  footprint: number;
}

export const SPECIES: Record<SpeciesId, SpeciesDef> = {
  // Acropora palmata — the reef crest's signature coral: flattened antler branches built to
  // shed wave energy, so it lives shallowest and most wave-exposed of anything here.
  elkhorn: {
    id: 'elkhorn', reefAssociated: true, depth: [0.8, 2, 5.5, 7.5],
    colorLo: 0xd98a4e, colorHi: 0xe8b06a, scale: [0.7, 1.6], footprint: 2.2,
  },
  // Acropora cervicornis — round branching thickets, mid-slope below the crest.
  staghorn: {
    id: 'staghorn', reefAssociated: true, depth: [2.5, 4.5, 10, 13.5],
    colorLo: 0xc9915a, colorHi: 0xdba86a, scale: [0.6, 1.4], footprint: 1.8,
  },
  // Colpophyllia natans / Diploria — smooth meandering-ridge boulder, deeper on the wall.
  brain: {
    id: 'brain', reefAssociated: true, depth: [5, 8, 18, 28],
    colorLo: 0x8a6a4a, colorHi: 0xb08a5a, scale: [0.8, 2.2], footprint: 2.6,
  },
  // Orbicella / Montastraea — knobbier, more irregular boulder than brain coral.
  star: {
    id: 'star', reefAssociated: true, depth: [6, 9, 22, 32],
    colorLo: 0x9a7a52, colorHi: 0xc79a5e, scale: [0.8, 2.4], footprint: 2.8,
  },
  // Gorgonia ventalina — the purple sea fan; flat, lacy, oriented broadside to the prevailing
  // current (see placement.ts's `fanOrientation`).
  seaFan: {
    id: 'seaFan', reefAssociated: true, depth: [2, 4, 16, 24],
    colorLo: 0x6a3f82, colorHi: 0x9a5fae, scale: [0.6, 1.5], footprint: 1.4,
  },
  // Pseudoplexaura / Pseudopterogorgia — bushy upright soft-coral plumes/rods.
  seaPlume: {
    id: 'seaPlume', reefAssociated: true, depth: [2, 4, 14, 22],
    colorLo: 0x5a6a3a, colorHi: 0x8a9a52, scale: [0.6, 1.3], footprint: 1.1,
  },
  // Xestospongia muta — giant barrel sponge, deep wall ledges.
  barrelSponge: {
    id: 'barrelSponge', reefAssociated: true, depth: [10, 15, 35, 55],
    colorLo: 0x7a3f3a, colorHi: 0xa85a4a, scale: [0.7, 1.8], footprint: 1.6,
  },
  // Aplysina / Callyspongia clustered tube sponges — also deep wall ledges.
  tubeSponge: {
    id: 'tubeSponge', reefAssociated: true, depth: [8, 12, 28, 45],
    colorLo: 0x8a6a9a, colorHi: 0xd4b25a, scale: [0.6, 1.5], footprint: 1.2,
  },
  // Low encrusting/plate corals (Porites etc.) filling gaps between the larger heads.
  encrusting: {
    id: 'encrusting', reefAssociated: true, depth: [2, 4, 20, 30],
    colorLo: 0x6a8a5a, colorHi: 0x9ab06a, scale: [0.5, 1.2], footprint: 1.6,
  },
  // Thalassia testudinum turtle-grass flats — explicitly not reef-associated.
  seagrass: {
    id: 'seagrass', reefAssociated: false, depth: [0.6, 1.2, 3.6, 4.9],
    colorLo: 0x2f6a3a, colorHi: 0x4a8a4a, scale: [0.7, 1.4], footprint: 0.5,
  },
};

export const SPECIES_LIST: SpeciesDef[] = Object.values(SPECIES);
