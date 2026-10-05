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
  /**
   * How much this organism moves in current, 0..1 — the amplitude knob for the sway in
   * materials.ts. This is a real biomechanical split, not an art dial: seagrass blades are
   * unlignified ribbons that lie over in a strong current, gorgonians (sea plumes, sea fans) are
   * flexible proteinaceous colonies built to flex *because* they live in surge, and stony corals
   * are rigid aragonite skeletons that do not move at all. Anything at 0 never gets the sway
   * shader compiled in, so rigid species cost nothing for it.
   */
  flexibility: number;
}

export const SPECIES: Record<SpeciesId, SpeciesDef> = {
  // Acropora palmata — the reef crest's signature coral: flattened antler branches built to
  // shed wave energy, so it lives shallowest and most wave-exposed of anything here. Mustard to
  // golden-brown — pushed well more saturated than a photo-literal sample reads on screen, because
  // a desaturated/dim coral is indistinguishable from "rock" at these view distances (see this
  // module's report: the previous palette read as drowned driftwood, not living coral).
  elkhorn: {
    id: 'elkhorn', reefAssociated: true, depth: [0.8, 2, 5.5, 7.5],
    colorLo: 0xc8860f, colorHi: 0xf0c23e, scale: [0.6, 1.3], footprint: 1.7,
    // Rigid aragonite — its whole adaptation to the surf zone is being strong enough not to move.
    flexibility: 0,
  },
  // Acropora cervicornis — round branching thickets, mid-slope below the crest. Pale cream-tan,
  // paler than elkhorn (real staghorn is visibly lighter/pinker than elkhorn's gold).
  staghorn: {
    id: 'staghorn', reefAssociated: true, depth: [2.5, 4.5, 10, 13.5],
    colorLo: 0xd6a86a, colorHi: 0xf2dcae, scale: [0.6, 1.4], footprint: 1.6,
    // Rigid aragonite, as elkhorn.
    flexibility: 0,
  },
  // Colpophyllia natans / Diploria — meandering-ridge boulder, deeper on the wall. Warm
  // olive-gold base; the actual meander pattern comes from grooveNormalTex (textures.ts), not from
  // colour alone — see materials.ts.
  brain: {
    id: 'brain', reefAssociated: true, depth: [5, 8, 18, 28],
    colorLo: 0x8a7a2e, colorHi: 0xcdb15a, scale: [0.7, 1.7], footprint: 1.8,
    // A boulder. Does not move.
    flexibility: 0,
  },
  // Orbicella / Montastraea — knobbier, more irregular boulder than brain coral; slightly greener
  // and darker than brain so the two read as different species side by side.
  star: {
    id: 'star', reefAssociated: true, depth: [6, 9, 22, 32],
    colorLo: 0x766a24, colorHi: 0xb8a048, scale: [0.7, 1.9], footprint: 2.0,
    // A boulder. Does not move.
    flexibility: 0,
  },
  // Gorgonia ventalina — the purple sea fan; flat, lacy, oriented broadside to the prevailing
  // current (see placement.ts's `fanOrientation`). Violet is right for a gorgonian, but the first
  // pass was pushed hot-magenta-bright on a mask that was (bug, see textures.ts's fanAlphaTex)
  // rendering nearly opaque — at full saturation and full coverage it read as plastic. Softened
  // now that the mesh is a genuine net: real light passing through a real gap reads as "alive" on
  // its own, without needing the colour itself to shout.
  seaFan: {
    id: 'seaFan', reefAssociated: true, depth: [2, 4, 16, 24],
    colorLo: 0x6a3582, colorHi: 0xa072b8, scale: [0.6, 1.4], footprint: 1.1,
    // Gorgonin colony, but a broad stiff plane held broadside to the flow — it rocks about
    // its base rather than whipping, and resists far more than a slender plume does.
    flexibility: 0.34,
  },
  // Pseudoplexaura / Pseudopterogorgia — bushy upright soft-coral plumes/rods. Yellow-green,
  // brightened for the same "must read as alive, not as algae-on-a-rock" reason as the rest.
  seaPlume: {
    id: 'seaPlume', reefAssociated: true, depth: [2, 4, 14, 22],
    colorLo: 0x5c7a2a, colorHi: 0xa8c858, scale: [0.6, 1.3], footprint: 0.9,
    // Slender flexible gorgonian rods — the classic "waving" soft coral of a Keys reef.
    flexibility: 0.72,
  },
  // Xestospongia muta — giant barrel sponge, deep wall ledges. Strong orange-red colour accent —
  // this is the single most saturated organism on a real wall and should pop from a distance.
  barrelSponge: {
    id: 'barrelSponge', reefAssociated: true, depth: [10, 15, 35, 55],
    colorLo: 0xb8431a, colorHi: 0xf08a42, scale: [0.7, 1.6], footprint: 1.3,
    // A rigid silica/spongin barrel.
    flexibility: 0,
  },
  // Aplysina / Callyspongia clustered tube sponges — also deep wall ledges. Violet-to-gold range
  // covers both the purple and the yellow tube-sponge species real Keys walls carry.
  tubeSponge: {
    id: 'tubeSponge', reefAssociated: true, depth: [8, 12, 28, 45],
    colorLo: 0x9850c0, colorHi: 0xecc850, scale: [0.6, 1.4], footprint: 1.0,
    // Near-rigid; only the thinnest tube tips register surge at all.
    flexibility: 0.08,
  },
  // Low encrusting/plate corals (Porites etc.) filling gaps between the larger heads. Bright
  // yellow-green — Porites astreoides in particular is a notably saturated chartreuse in life.
  encrusting: {
    id: 'encrusting', reefAssociated: true, depth: [2, 4, 20, 30],
    colorLo: 0x7cae3c, colorHi: 0xc8e878, scale: [0.5, 1.2], footprint: 1.3,
    // A crust on the rock. Nothing to move.
    flexibility: 0,
  },
  // Thalassia testudinum turtle-grass flats — explicitly not reef-associated.
  seagrass: {
    // Extended down from 4.9 m: Thalassia testudinum grows to ~10 m in water this clear, and the
    // old ceiling stopped the beds dead at the inshore edge of Hawk Channel — i.e. exactly where a
    // diver actually swims. Now grass carries from the shallow flats out to the channel floor.
    id: 'seagrass', reefAssociated: false, depth: [0.5, 1.2, 6.5, 9.5],
    colorLo: 0x2f7a3a, colorHi: 0x5cae52, scale: [0.7, 1.4], footprint: 0.5,
    // Unlignified ribbon blades — the most mobile thing on the seafloor, and the reference
    // point this whole scale is normalised against.
    flexibility: 1,
  },
};

export const SPECIES_LIST: SpeciesDef[] = Object.values(SPECIES);
