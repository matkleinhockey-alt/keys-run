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

/**
 * ⚠ Colour-choice constraint discovered by this module's report (`reef-realism` pass): the global
 * underwater extinction override (`world/underwater/fog-override.ts`, out of this directory's
 * scope) attenuates red ~5x faster than green and ~15x faster than blue
 * (`k_red/k_green/k_blue = 0.171/0.0342/0.0114` per metre at its current `EXTINCTION_SCALE`).
 * Modelling `transmit*albedo + inscatter*(1-transmit)` against that formula shows there is no
 * valid sRGB albedo — not even pure (255,0,0) red-orange — that stays red/green-*balanced* past
 * roughly a 10-12 m combined (distance + depth) path; green wins any colour whose own green
 * channel is more than ~30% of its red channel once the path exceeds ~8 m. That is a hard
 * property of the global fog, not a texture/material bug, and no palette choice here fixes it at
 * real mid-range — see this module's report for the numbers. What a palette *can* still do:
 *  1. Bias every "warm" species' hue hard toward red/orange (minimise green) rather than true
 *     gold/yellow, so it reads warm at CLOSE range (a diver is almost always within a few metres
 *     of the coral they're looking at, even though they can *see* 20-30 m) instead of collapsing
 *     to green-dominant the instant it's lit.
 *  2. Raise overall value/brightness, since every one of these numbers is dim after the subtract.
 *  3. Lean on species whose true colour is blue/violet/green (sea fans, sea plumes, encrusting) —
 *     those survive this filter well and are what should carry hue variety at real distance, while
 *     the red-leaning species carry it up close and carry shape/texture contrast at range instead.
 */
export const SPECIES: Record<SpeciesId, SpeciesDef> = {
  // Acropora palmata — the reef crest's signature coral: flattened antler branches built to
  // shed wave energy, so it lives shallowest and most wave-exposed of anything here. Shifted from
  // a yellow-gold toward a deeper burnt-orange/rust: a yellow-gold's green channel is already
  // close to its red (see this file's header), so it is the first hue to die to green underwater;
  // rust/terracotta keeps red clearly ahead of green at realistic viewing range while still
  // reading unmistakably warm next to brain/star's olive and seaFan's violet.
  elkhorn: {
    id: 'elkhorn', reefAssociated: true, depth: [0.8, 2, 5.5, 7.5],
    colorLo: 0x9c3a0a, colorHi: 0xe8841f, scale: [0.6, 1.3], footprint: 1.7,
    // Rigid aragonite — its whole adaptation to the surf zone is being strong enough not to move.
    flexibility: 0,
  },
  // Acropora cervicornis — round branching thickets, mid-slope below the crest. Real staghorn is
  // visibly lighter/pinker than elkhorn's gold — kept as a warm coral-salmon rather than cream-tan
  // for the same red-survives-better-than-gold reason as elkhorn, just paler/pinker than it.
  staghorn: {
    id: 'staghorn', reefAssociated: true, depth: [2.5, 4.5, 10, 13.5],
    colorLo: 0xc9704a, colorHi: 0xf0b89a, scale: [0.6, 1.4], footprint: 1.6,
    // Rigid aragonite, as elkhorn.
    flexibility: 0,
  },
  // Colpophyllia natans / Diploria — meandering-ridge boulder, deeper on the wall. Shifted from
  // olive-gold toward a warmer rust-brown for the same reason as elkhorn; the actual meander
  // pattern comes from grooveNormalTex (textures.ts) plus this module's own per-vertex colour
  // (geometry.ts's `paintVertexColors`), not from the lerped instance colour alone.
  brain: {
    id: 'brain', reefAssociated: true, depth: [5, 8, 18, 28],
    colorLo: 0x7a3f16, colorHi: 0xb8752e, scale: [0.7, 1.7], footprint: 1.8,
    // A boulder. Does not move.
    flexibility: 0,
  },
  // Orbicella / Montastraea — knobbier, more irregular boulder than brain coral; kept slightly
  // more olive/green-leaning than brain (its own real-world distinction) while still pushed
  // warmer/brighter than the old palette.
  star: {
    id: 'star', reefAssociated: true, depth: [6, 9, 22, 32],
    colorLo: 0x6a4c14, colorHi: 0x9c7c3c, scale: [0.7, 1.9], footprint: 2.0,
    // A boulder. Does not move.
    flexibility: 0,
  },
  // Gorgonia ventalina — the purple sea fan; flat, lacy, oriented broadside to the prevailing
  // current (see placement.ts's `fanOrientation`, now sourced from the shared current field — see
  // this file's header). Blue/violet hue survives the underwater extinction filter far better than
  // any warm colour (its blue channel is barely attenuated at all), so sea fans are one of the
  // species that should still read as unmistakably their own colour at real reef distance —
  // brightened/saturated a notch from the previous pass so that advantage actually shows.
  seaFan: {
    id: 'seaFan', reefAssociated: true, depth: [2, 4, 16, 24],
    colorLo: 0x7a3a94, colorHi: 0xb088d0, scale: [0.6, 1.4], footprint: 1.1,
    // Gorgonin colony, but a broad stiff plane held broadside to the flow — it rocks about
    // its base rather than whipping, and resists far more than a slender plume does.
    flexibility: 0.34,
  },
  // Pseudoplexaura / Pseudopterogorgia — bushy upright soft-coral plumes/rods. Yellow-green's own
  // green channel survives the extinction filter nearly as well as true green does, so this
  // species (like encrusting/seagrass) is one of the ones that should still carry real hue at
  // range — brightened further from the previous pass to make the most of that.
  seaPlume: {
    id: 'seaPlume', reefAssociated: true, depth: [2, 4, 14, 22],
    colorLo: 0x6c8a2e, colorHi: 0xb8d868, scale: [0.6, 1.3], footprint: 0.9,
    // Slender flexible gorgonian rods — the classic "waving" soft coral of a Keys reef.
    flexibility: 0.72,
  },
  // Xestospongia muta — giant barrel sponge, deep wall ledges. Pushed to the reddest, most
  // saturated colour on this whole roster on purpose: it lives deepest of the "warm" species (the
  // path length working against it is the longest), so it needs the biggest head start to still
  // register as red-orange rather than olive by the time light reaches the eye.
  barrelSponge: {
    id: 'barrelSponge', reefAssociated: true, depth: [10, 15, 35, 55],
    colorLo: 0xa8280f, colorHi: 0xe85a28, scale: [0.7, 1.6], footprint: 1.3,
    // A rigid silica/spongin barrel.
    flexibility: 0,
  },
  // Aplysina / Callyspongia clustered tube sponges — also deep wall ledges. The violet end keeps
  // its real colour at depth for the same reason seaFan does; the old yellow-gold end is replaced
  // with a warm coral-orange — yellow is exactly the "green-channel-too-close-to-red" hue this
  // file's header flags, and at tube sponge's own deep range (8-45 m) it would be the first thing
  // on this roster to turn fully olive.
  tubeSponge: {
    id: 'tubeSponge', reefAssociated: true, depth: [8, 12, 28, 45],
    colorLo: 0x8c48b0, colorHi: 0xe8905c, scale: [0.6, 1.4], footprint: 1.0,
    // Near-rigid; only the thinnest tube tips register surge at all.
    flexibility: 0.08,
  },
  // Low encrusting/plate corals (Porites etc.) filling gaps between the larger heads. Bright
  // yellow-green — Porites astreoides in particular is a notably saturated chartreuse in life, and
  // (like seaPlume) true green is one of the hues that actually survives this world's underwater
  // extinction filter, so it is left green rather than warmed.
  encrusting: {
    id: 'encrusting', reefAssociated: true, depth: [2, 4, 20, 30],
    colorLo: 0x7cae3c, colorHi: 0xd4f088, scale: [0.5, 1.2], footprint: 1.3,
    // A crust on the rock. Nothing to move.
    flexibility: 0,
  },
  // Thalassia testudinum turtle-grass flats — explicitly not reef-associated.
  seagrass: {
    // Depth range is a *gameplay* boundary as much as a biological one. Thalassia really does
    // reach ~10 m in water this clear, and an earlier pass extended it there — which put dense
    // grass across the whole floor of Hawk Channel at 8 m. From the helm that reads as dark
    // scratchy streaks over water that is otherwise the best-looking thing in the game, and it
    // buries the fish you are supposed to be spotting. The channel is where you *drive*; the
    // flats are where you dive. Grass stops before the channel floor starts.
    id: 'seagrass', reefAssociated: false, depth: [0.5, 1.0, 3.4, 5.2],
    colorLo: 0x2f7a3a, colorHi: 0x5cae52, scale: [0.7, 1.4], footprint: 0.5,
    // Unlignified ribbon blades — the most mobile thing on the seafloor, and the reference
    // point this whole scale is normalised against.
    flexibility: 1,
  },
};

export const SPECIES_LIST: SpeciesDef[] = Object.values(SPECIES);
