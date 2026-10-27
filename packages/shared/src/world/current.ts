/**
 * Ocean current: the Florida Current (Gulf Stream), tidal flow through the chain, and wave surge.
 *
 * Before this module the world had the Gulf Stream as *bathymetry only* — `depthAt`'s `dz >= 1650`
 * branch drops to 45.4 m and keeps going, and `offshoreF` ramps 0->1 across it — but nothing in
 * the game ever moved because of it. The water was geometrically deep and hydrodynamically dead.
 *
 * Lives in `packages/shared` (pure: no three.js, no DOM, no `Date.now()`) because current is
 * physics, not decoration. docs/ARCHITECTURE.md's authority model has the server simulating the
 * diver and shadow-simulating boats; both need the same flow field the client renders weeds and
 * marine snow against, or a drifting diver desyncs. Same reason `waveHBase` is shared.
 *
 * Three superposed components, each with a different job:
 *
 *  1. **Florida Current** — the steady, one-way, offshore-dominant flow. Runs *up* the Keys
 *     (northeast, +x in this world's frame) along the island chain. This is the one that makes
 *     offshore feel different from inshore.
 *  2. **Tide** — a slow reversing flow along the same axis, strongest inshore and in the cuts,
 *     which is where real tidal current actually concentrates (the Gulf Stream doesn't reverse;
 *     Vaca Cut and the bridge channels very much do).
 *  3. **Surge** — the fast back-and-forth of wave orbital motion in shallow water. This is the
 *     component you *see*: it is what makes seagrass and gorgonians rock in unison on a reef and
 *     then go still, and it dies off with depth exactly as orbital motion does.
 *
 * Returned velocities are m/s in world axes, directly usable as a drift term.
 */
import { clamp } from '../internal/math.js';
import { chainZ, islands } from './chain.js';
import { offshoreF } from './depth.js';

export interface Flow {
  /** World-axis velocity, m/s. */
  vx: number;
  vz: number;
  /** `Math.hypot(vx, vz)` — precomputed because almost every caller wants it. */
  speed: number;
}

/**
 * Peak Florida Current speed (m/s) at full `offshoreF`. The real Florida Current core runs
 * 1.5-2.0 m/s, but its axis sits 15-30 km offshore of the Keys — far outside this world's
 * playable box, whose `offshoreF` saturates only ~2.2 km past the reef wall. So this is the
 * *inshore edge* of the stream compressed onto the available water: strong enough to be felt and
 * to pin weeds over, well short of the unswimmable real thing.
 */
export const GULF_MAX_SPEED = 1.15;

/** Peak tidal speed (m/s) on a spring flood through a cut. Reverses; see `TIDE_PERIOD_S`. */
export const TIDE_MAX_SPEED = 0.42;

/**
 * Tidal period, seconds. A real semidiurnal cycle is 12.42 h, which inside one play session is
 * indistinguishable from a constant. Compressed to 16 minutes so a long dive or a run out to the
 * reef and back actually crosses a slack-and-reverse, while staying slow enough that it reads as
 * "the tide turned" rather than as an oscillator.
 */
export const TIDE_PERIOD_S = 960;

/* ------------------------------------------------------------------ tidal cuts -------------- */

/**
 * The cuts through the island chain, and the tide ripping through them.
 *
 * This is the piece the flow field was missing. The three components above all run along the
 * SAME axis — the chain tangent — so wherever you went the current pointed up or down the Keys
 * and only its strength changed. Real current here does not behave like that at all: the thing
 * everyone who runs these waters actually plans around is the tide pouring between the islands,
 * across the chain rather than along it, and doing it hard enough in the narrow cuts to decide
 * whether you can hold position at all.
 *
 * It is continuity that makes them interesting. The same tidal prism has to move between Florida
 * Bay and the ocean through whatever gap there is, so a narrow throat runs fast and a wide span
 * barely moves. That falls straight out of the island geometry already in `chain.ts`: merge the
 * land into spans, and the holes between them are the cuts, with Vaca Cut genuinely the tightest
 * at fifty metres — which is exactly why, in life, it rips.
 */
export interface TidalCut {
  /** Along-chain centre of the gap. */
  x: number;
  /** Gap width, metres. */
  width: number;
  /** Peak flow through it, m/s, from the continuity scaling below. */
  speed: number;
}

/** Width at which a cut runs `CUT_REF_SPEED`; narrower is faster in proportion. */
export const CUT_REF_WIDTH = 120;
export const CUT_REF_SPEED = 0.9;
/** Nothing runs faster than this, however tight the gap. A diver can still work the edges of
 * even the worst of it, and only at peak flow is the throat itself unswimmable. */
export const CUT_MAX_SPEED = 1.6;
/** Chain-adjacent means within this of the chain line: the Miami islands sit 1.7 km north and
 * Boot Key hangs south of Vaca, and neither forms a cut. */
const CHAIN_BAND = 420;
/** A gap narrower than this is a creek, not a cut; wider than this is open water, not a channel. */
const MIN_CUT_W = 30;
const MAX_CUT_W = 1400;
/** How far the jet carries out of a cut before it spreads, metres. */
const CUT_PLUME_M = 520;

function buildCuts(): TidalCut[] {
  const spans = islands
    .filter((I) => !I.mainland && Math.abs(I.z - chainZ(I.x)) < CHAIN_BAND)
    .map((I) => [I.x - I.a, I.x + I.a] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  // Merge overlapping land first, or two islands that touch invent a gap between them.
  const merged: Array<[number, number]> = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else merged.push([sp[0], sp[1]]);
  }
  const cuts: TidalCut[] = [];
  for (let i = 1; i < merged.length; i++) {
    const a = merged[i - 1][1], b = merged[i][0], w = b - a;
    if (w < MIN_CUT_W || w > MAX_CUT_W) continue;
    cuts.push({ x: (a + b) / 2, width: w, speed: Math.min(CUT_MAX_SPEED, CUT_REF_SPEED * (CUT_REF_WIDTH / w)) });
  }
  return cuts;
}

/** Derived once from the island layout — same islands, same cuts, every session. */
export const TIDAL_CUTS: readonly TidalCut[] = buildCuts();

/**
 * Flow through the cuts at a point: ACROSS the chain, reversing with the tide.
 *
 * Phased off the same sinusoid as the along-chain tide, so flood and ebb agree about which way
 * the water is going — the cuts fill the bay while the tide runs up the Keys, and empty it
 * while the tide runs back down.
 *
 * Falls off as a Gaussian both ways: tightly along the chain, because a jet through a 50 m hole
 * is a 50 m-wide jet, and more slowly across it, because that jet shoots a long plume out into
 * the channel on each side before it spreads.
 */
export function cutJetAt(x: number, z: number, t: number): Flow {
  const phase = Math.sin((t / TIDE_PERIOD_S) * Math.PI * 2);
  if (phase === 0 || !TIDAL_CUTS.length) return { vx: 0, vz: 0, speed: 0 };
  const dz = z - chainZ(x);
  const { nx, nz } = chainNormal(x);
  let vx = 0, vz = 0;
  for (const c of TIDAL_CUTS) {
    const sx = Math.max(60, c.width * 0.8);
    const du = (x - c.x) / sx;
    if (du * du > 9) continue;                       // 3 sigma out: nothing left to add
    const alongChain = Math.exp(-du * du);
    const dv = dz / CUT_PLUME_M;
    const across = Math.exp(-dv * dv);
    const s = c.speed * phase * alongChain * across;
    vx += nx * s;
    vz += nz * s;
  }
  return { vx, vz, speed: Math.hypot(vx, vz) };
}

/** Peak surge speed (m/s) at the surface in shallow water. */
export const SURGE_MAX_SPEED = 0.55;

/** Depth (m) by which wave orbital motion has effectively died out. Real orbital velocity decays
 * as exp(-2*pi*depth/wavelength); for the 20-60 m wind-wave scales this world's `WAVES` table
 * carries, ~22 m is where surge stops being something you can feel. */
export const SURGE_DECAY_DEPTH = 22;

/** Surge oscillation period, seconds — one wave group passing. */
const SURGE_PERIOD_S = 7.5;

/**
 * Unit tangent of the island chain at `x`, pointing "up the Keys" (+x, west -> east). `chainZ` is
 * `0.000012 * x^2`, so its slope is `0.000024 * x` — the chain is dead straight at the origin and
 * bends progressively toward +z further east. Both the Florida Current and the tide follow this
 * axis, because both are steered by the same reef line.
 */
export function chainTangent(x: number): { tx: number; tz: number } {
  const slope = 0.000024 * x;
  const inv = 1 / Math.hypot(1, slope);
  return { tx: inv, tz: slope * inv };
}

/**
 * Cross-shore unit normal at `x`, pointing offshore (+z, seaward). Perpendicular to
 * `chainTangent`; surge runs along this axis because waves approach the reef broadside.
 */
export function chainNormal(x: number): { nx: number; nz: number } {
  const { tx, tz } = chainTangent(x);
  return { nx: -tz, nz: tx };
}

/**
 * How exposed a point is to tidal flow, 0..1 — the inverse of `offshoreF`, so it peaks inshore
 * and in the channels and vanishes out in the stream. Kept as its own function (rather than
 * `1 - offshoreF`) because the real asymmetry matters: tidal current is concentrated in the cuts
 * *between* islands, and that is a different shape from "not offshore".
 */
export function tidalExposure(x: number, z: number): number {
  const dz = z - chainZ(x);
  // Peak right around the chain line and through Hawk Channel, falling off into the bay behind it
  // and out past the reef crest in front of it.
  const u = (dz - 300) / 1100;
  const band = Math.exp(-(u * u));
  return clamp(band * (1 - offshoreF(x, z)), 0, 1);
}

/**
 * Steady (non-oscillating) flow at a point: Florida Current plus the current phase of the tide.
 * Separated from `currentAt` because this is the component that should bias a *drifting* body —
 * a boat at anchor-up, a diver, a dormant school — whereas surge averages to zero over a few
 * seconds and only matters for things you watch move (weeds, marine snow).
 */
export function steadyCurrentAt(x: number, z: number, t: number): Flow {
  const { tx, tz } = chainTangent(x);

  const gulf = GULF_MAX_SPEED * offshoreF(x, z);
  // Tide reverses; `t` drives a plain sinusoid so flood and ebb are symmetric and slack water is
  // a real (brief) moment rather than a discontinuity.
  const tide = TIDE_MAX_SPEED * tidalExposure(x, z) * Math.sin((t / TIDE_PERIOD_S) * Math.PI * 2);

  const s = gulf + tide;
  // ...plus whatever is pouring through the nearest gap in the chain, which runs ACROSS this
  // axis rather than along it and is the only part of the field that is not parallel everywhere.
  const jet = cutJetAt(x, z, t);
  const vx = tx * s + jet.vx, vz = tz * s + jet.vz;
  return { vx, vz, speed: Math.hypot(vx, vz) };
}

/**
 * Wave-surge velocity: a fast reversing flow across the reef line, strongest at the surface in
 * shallow water and gone below `SURGE_DECAY_DEPTH`. `depth` is the water depth at the point
 * (`depthAt`); pass it in rather than recomputing, since every caller already has it.
 *
 * The spatial term makes surge a *travelling* phase rather than a global pulse, so a seagrass bed
 * rocks as a wave passes over it instead of twitching in lockstep — the single detail that makes
 * a weed bed read as being in water rather than in wind.
 */
export function surgeAt(x: number, z: number, t: number, depth: number): Flow {
  const decay = Math.exp(-Math.max(0, depth) / SURGE_DECAY_DEPTH);
  if (decay < 0.01) return { vx: 0, vz: 0, speed: 0 };
  const { nx, nz } = chainNormal(x);
  // Phase advances along the cross-shore axis: wavelength ~34 m, matching the mid-range of this
  // world's WAVES table, so the crest-to-crest spacing of the surge matches the swell you can see
  // on the surface above it.
  const phase = (t / SURGE_PERIOD_S) * Math.PI * 2 - (x * nx + z * nz) * (Math.PI * 2 / 34);
  const s = SURGE_MAX_SPEED * decay * Math.sin(phase);
  return { vx: nx * s, vz: nz * s, speed: Math.abs(s) };
}

/**
 * Total current at a point: steady flow plus surge. `depth` is the water depth (`depthAt`) — the
 * only reason it is a parameter rather than an internal `depthAt` call is that this is on hot
 * paths (per-particle, per-frame) where the caller invariably has the depth already.
 */
export function currentAt(x: number, z: number, t: number, depth: number): Flow {
  const a = steadyCurrentAt(x, z, t);
  const b = surgeAt(x, z, t, depth);
  const vx = a.vx + b.vx, vz = a.vz + b.vz;
  return { vx, vz, speed: Math.hypot(vx, vz) };
}
