/**
 * Deterministic, three.js-free reef placement — the module the determinism vitest suite
 * (apps/client/test/reef-placement.test.ts) exercises directly.
 *
 * Every candidate's attributes come from `hashCell(REEF_WORLD_SEED, cx, cz, salt)` where `(cx,
 * cz)` is the candidate's own CHUNK coordinate and `salt` folds in a fixed per-species
 * per-attribute literal plus the candidate's own slot index (see constants.ts's `foldSalt`) —
 * never an iteration-order counter. Concretely this buys two guarantees docs/ARCHITECTURE.md
 * calls non-negotiable:
 *   1. Calling `placeChunk(cx, cz)` twice (same process or a different one) byte-identical.
 *   2. Adding a new species to SPECIES/SPECIES_LIST never perturbs any existing species' output —
 *      each species only ever reads hash cells under its own fixed `saltBase` range.
 *
 * Real reef ecology (docs/ARCHITECTURE.md "Real reef ecology") drives *suitability*, a
 * continuous 0..1 function of actual `depthAt`/`zoneAt`, not a hard cutoff — elkhorn fades out
 * rather than snapping off at some exact metre mark, the same way the legacy coral scatter's own
 * `d < 13` checks already worked, just continuous instead of binary.
 */
import { hashCell } from '@keysrun/shared/rng';
import { chainZ } from '@keysrun/shared/world/chain';
import { depthAt, zoneAt, HUMPS } from '@keysrun/shared/world/depth';
import { clamp, lerp } from '../../core/math.js';
import {
  REEF_WORLD_SEED, CHUNK_SIZE, Attr, foldSalt, CANDIDATES_PER_CHUNK, WORLD_SALT,
  MICRO_PATCH_PROBABILITY, PATCH_REEF_FULL_RADIUS, PATCH_REEF_FADE_RADIUS,
  SOMBRERO_ANCHOR_X, SOMBRERO_ANCHOR_DZ, SOMBRERO_RADIUS, SOMBRERO_GROOVE_PERIOD,
} from './constants.js';
import { SPECIES, SPECIES_LIST, trapezoid, type SpeciesDef } from './species.js';
import { reefGroundY } from './terrain.js';
import type { ChunkCoord, ChunkPlacement, ReefInstance, SpeciesId } from './types.js';

export function worldToChunk(x: number, z: number): ChunkCoord {
  return { cx: Math.floor(x / CHUNK_SIZE), cz: Math.floor(z / CHUNK_SIZE) };
}

export function chunkOrigin(cx: number, cz: number): { x0: number; z0: number } {
  return { x0: cx * CHUNK_SIZE, z0: cz * CHUNK_SIZE };
}

const smoothstep = (v: number, lo: number, hi: number): number => {
  const t = clamp((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Local tangent to the island chain at x (chainZ's own derivative — see world/chain.ts: `chainZ
 * = 0.000012*x*x`), normalized. Used to orient sea fans broadside to the prevailing current. */
function chainTangent(x: number): [number, number] {
  const slope = 0.000024 * x; // d/dx of 0.000012*x*x
  const len = Math.hypot(1, slope);
  return [1 / len, slope / len];
}

/** The cross-shore direction (perpendicular to the chain, pointing offshore/+dz) at x. Real
 * Keys reef-tract currents run predominantly alongshore (parallel to the chain); a sea fan
 * oriented with its flat face normal along this cross-shore axis stands broadside to that flow —
 * "oriented across the current" (docs/ARCHITECTURE.md "Real reef ecology"). */
function crossShoreNormal(x: number): [number, number] {
  const [tx, tz] = chainTangent(x);
  return [-tz, tx];
}

/** Distance-based fade (1 at the patch's center, 0 beyond PATCH_REEF_FADE_RADIUS) to the nearest
 * named patch-reef HUMPS entry (Coffins Patch, Delta Shoal) — these sit in Hawk Channel, not the
 * `zoneAt === 'Reef'` wall, so they need their own radius-based gate. */
function nearestPatchReefFactor(x: number, dzLocal: number): number {
  let best = 0;
  for (const H of HUMPS) {
    if (!H.patch) continue;
    const dist = Math.hypot(x - H.x, dzLocal - H.dz);
    const f = dist <= PATCH_REEF_FULL_RADIUS ? 1
      : dist >= PATCH_REEF_FADE_RADIUS ? 0
      : 1 - (dist - PATCH_REEF_FULL_RADIUS) / (PATCH_REEF_FADE_RADIUS - PATCH_REEF_FULL_RADIUS);
    if (f > best) best = f;
  }
  return best;
}

function isMicroPatchChunk(cx: number, cz: number): boolean {
  return hashCell(REEF_WORLD_SEED, cx, cz, WORLD_SALT.MICRO_PATCH_PRESENT) < MICRO_PATCH_PROBABILITY;
}

/** Suppresses coral density in winding bands so bare sand channels thread between coral heads
 * (docs/ARCHITECTURE.md "Sand channels between coral heads"). Near Sombrero Reef this switches
 * to parallel cross-shore grooves instead of wandering noise — Sombrero's real, famous
 * "spur-and-groove" geomorphology — so that named site reads distinctly from generic reef. */
function sandChannelFactor(x: number, dzLocal: number): number {
  const sombDist = Math.hypot(x - SOMBRERO_ANCHOR_X, dzLocal - SOMBRERO_ANCHOR_DZ);
  if (sombDist < SOMBRERO_RADIUS) {
    const phase = (x / SOMBRERO_GROOVE_PERIOD) * Math.PI * 2;
    const groove = Math.sin(phase) * 0.5 + 0.5;
    return smoothstep(groove, 0.32, 0.56);
  }
  const n = Math.sin(x * 0.013 + dzLocal * 0.021) * 0.5 + Math.sin(x * 0.027 - dzLocal * 0.011) * 0.5;
  return smoothstep(n, -0.35, 0.05);
}

export type DiveSite = 'sombrero' | 'coffins' | 'delta' | null;

/** Which named dive site (if any) covers (x,z), and how central (1 at the anchor, 0 at the
 * edge) — drives per-site species/density dressing so Sombrero Reef, Coffins Patch and Delta
 * Shoal read as distinct, recognisable places rather than one generic reef texture repeated
 * (docs/ARCHITECTURE.md "Named dive sites"). */
export function diveSiteAt(x: number, z: number): { site: DiveSite; t: number } {
  const dzLocal = z - chainZ(x);
  const sombDist = Math.hypot(x - SOMBRERO_ANCHOR_X, dzLocal - SOMBRERO_ANCHOR_DZ);
  if (sombDist < SOMBRERO_RADIUS) return { site: 'sombrero', t: 1 - sombDist / SOMBRERO_RADIUS };
  const coffins = HUMPS.find((h) => h.name === 'Coffins Patch');
  if (coffins) {
    const dist = Math.hypot(x - coffins.x, dzLocal - coffins.dz);
    if (dist < PATCH_REEF_FADE_RADIUS) return { site: 'coffins', t: 1 - dist / PATCH_REEF_FADE_RADIUS };
  }
  const delta = HUMPS.find((h) => h.name === 'Delta Shoal');
  if (delta) {
    const dist = Math.hypot(x - delta.x, dzLocal - delta.dz);
    if (dist < PATCH_REEF_FADE_RADIUS) return { site: 'delta', t: 1 - dist / PATCH_REEF_FADE_RADIUS };
  }
  return { site: null, t: 0 };
}

function siteDensityMultiplier(site: DiveSite, id: SpeciesId, t: number): number {
  if (site === 'sombrero') {
    // Sombrero: thick elkhorn/staghorn crest growth between the spur-and-groove sand channels.
    return id === 'elkhorn' || id === 'staghorn' ? 1 + 0.4 * t : 1 + 0.1 * t;
  }
  if (site === 'coffins') {
    // Coffins Patch: a dense, mounded patch reef with a lacy fringe of fans/plumes.
    return id === 'seaFan' || id === 'seaPlume' ? 1 + 0.55 * t : 1 + 0.3 * t;
  }
  if (site === 'delta') {
    // Delta Shoal: shallower, sparser, more exposed sand between scattered heads.
    if (id === 'seaFan' || id === 'seaPlume' || id === 'tubeSponge' || id === 'barrelSponge') return Math.max(0.3, 1 - 0.6 * t);
    return Math.max(0.5, 1 - 0.35 * t);
  }
  return 1;
}

/** True if (x,z) is reef/patch-reef-like enough that seagrass should not grow there — "seagrass
 * beds on the shallow flats, not on the reef" (docs/ARCHITECTURE.md). */
function isReefLike(x: number, z: number): boolean {
  if (zoneAt(x, z) === 'Reef') return true;
  const dzLocal = z - chainZ(x);
  return nearestPatchReefFactor(x, dzLocal) > 0.15;
}

/** 0..1 continuous suitability of species at exact world (x,z) — the product of depth
 * membership, zone/patch-reef gating, the sand-channel mask and dive-site dressing. Zero means
 * "never place here"; candidates are rejected by comparing this against a per-slot hash draw
 * (see `placeSpeciesInChunk`), so density fades smoothly rather than snapping at a hard edge. */
export function suitability(species: SpeciesDef, x: number, z: number): number {
  const d = depthAt(x, z);
  const depthM = trapezoid(d, species.depth[0], species.depth[1], species.depth[2], species.depth[3]);
  if (depthM <= 0) return 0;

  if (!species.reefAssociated) {
    return isReefLike(x, z) ? 0 : depthM;
  }

  const dzLocal = z - chainZ(x);
  const zone = zoneAt(x, z);
  const patch = nearestPatchReefFactor(x, dzLocal);
  const { cx, cz } = worldToChunk(x, z);
  const micro = zone === 'Hawk Channel' && isMicroPatchChunk(cx, cz) ? 1 : 0;
  const reefGate = zone === 'Reef' ? 1 : Math.max(patch, micro);
  if (reefGate <= 0) return 0;

  const sand = sandChannelFactor(x, dzLocal);
  if (sand <= 0) return 0;

  const { site, t } = diveSiteAt(x, z);
  const siteMul = siteDensityMultiplier(site, species.id, t);

  return clamp(depthM * reefGate * sand * siteMul, 0, 1);
}

/** Fixed, hardcoded (never list-order- or index-derived — see this file's header) set of
 * volumetric "solid" species that a flat alpha-cut card must not be allowed to spawn inside of.
 * Without this, a sea fan/plume candidate can land with its card slicing straight through a
 * nearby brain/star boulder or sponge; at the wrong angle the lacy alpha-cutout then reads as a
 * painted-on decal rather than two separate organisms — a real, visible glitch (see this module's
 * report), not a cosmetic nicety. Seagrass never needs this: `isReefLike` already keeps it off the
 * reef entirely, so it never shares a candidate slot with any of these. */
const CARD_SPECIES: ReadonlySet<SpeciesId> = new Set<SpeciesId>(['seaFan', 'seaPlume']);
const SOLID_OBSTACLE_IDS: SpeciesId[] = ['elkhorn', 'staghorn', 'brain', 'star', 'encrusting', 'barrelSponge', 'tubeSponge'];

/** Every one of `SOLID_OBSTACLE_IDS`' own placement in this chunk, recomputed from their fixed
 * saltBase regardless of what list the caller passed to `placeChunk` — so a card species' output
 * depends only on this chunk's fixed obstacle roster, never on iteration order or on what other
 * species happen to be in scope. (Same determinism contract as everything else in this file; see
 * header.) */
function solidObstaclesInChunk(cx: number, cz: number): ReefInstance[] {
  const out: ReefInstance[] = [];
  for (const id of SOLID_OBSTACLE_IDS) out.push(...placeSpeciesInChunk(SPECIES[id], cx, cz));
  return out;
}

/** True if a card candidate at (x,z) (already scaled to `cardRadius`, its own realized half-
 * footprint — see call site) would visibly intersect a solid obstacle instance. Uses each
 * obstacle's own *realized* half-footprint (`species.footprint * 0.5 * max(scaleX,scaleZ)`, from
 * that instance's own already-rolled scale), not the species' nominal footprint — a brain/star
 * coral can scale up to 2.2-2.8x (species.ts), and checking only the unscaled nominal size let an
 * oversized boulder's actual silhouette extend well past the heuristic's buffer.
 *
 * `OVERLAP_FRACTION` shrinks the combined-radii test distance: at this module's much higher
 * density (see constants.ts's report) a full edge-to-edge threshold rejects nearly every card
 * candidate in a crowded chunk, since *something* obstacle-sized is within combined-radius
 * distance almost everywhere — that collapsed sea fan/plume counts to near zero. Real fans do grow
 * right up against, even touching, a neighbouring coral head; only a candidate landing well inside
 * an obstacle's own silhouette needs rejecting. */
const OVERLAP_FRACTION = 0.4;
function collidesWithObstacle(x: number, z: number, cardRadius: number, obstacles: ReefInstance[]): boolean {
  for (const o of obstacles) {
    const obRadius = SPECIES[o.species].footprint * 0.5 * Math.max(o.scaleX, o.scaleZ);
    if (Math.hypot(o.x - x, o.z - z) < (cardRadius + obRadius) * OVERLAP_FRACTION) return true;
  }
  return false;
}

/** Every candidate slot's attributes (presence roll, offset, rotation, scale, colour, tilt) are
 * each their own independent `hashCell` draw keyed only on (chunk, species, attribute, slot) —
 * see constants.ts's `foldSalt` header for why that is what makes this safe under reordering. */
export function placeSpeciesInChunk(species: SpeciesDef, cx: number, cz: number): ReefInstance[] {
  const count = CANDIDATES_PER_CHUNK[species.id];
  const { x0, z0 } = chunkOrigin(cx, cz);
  const out: ReefInstance[] = [];
  // Computed once per call (not per-slot) and only for the two card species — see header note
  // above `CARD_SPECIES`.
  const obstacles = CARD_SPECIES.has(species.id) ? solidObstaclesInChunk(cx, cz) : null;

  for (let slot = 0; slot < count; slot++) {
    const ox = hashCell(REEF_WORLD_SEED, cx, cz, foldSalt(species.id, Attr.OFFSET_X, slot));
    const oz = hashCell(REEF_WORLD_SEED, cx, cz, foldSalt(species.id, Attr.OFFSET_Z, slot));
    const x = x0 + ox * CHUNK_SIZE;
    const z = z0 + oz * CHUNK_SIZE;

    // Rolled here (ahead of its other uses below) only because the obstacle-collision check
    // needs this candidate's own realized half-footprint; the hashCell draw itself is unaffected
    // by being read earlier — same (chunk, species, attribute, slot) key either way.
    const scaleT = hashCell(REEF_WORLD_SEED, cx, cz, foldSalt(species.id, Attr.SCALE, slot));
    const baseScale = lerp(species.scale[0], species.scale[1], scaleT);

    if (obstacles && collidesWithObstacle(x, z, species.footprint * 0.5 * baseScale, obstacles)) continue;

    const suit = suitability(species, x, z);
    if (suit <= 0) continue;
    const roll = hashCell(REEF_WORLD_SEED, cx, cz, foldSalt(species.id, Attr.PRESENCE, slot));
    if (roll >= suit) continue;

    const rotRoll = hashCell(REEF_WORLD_SEED, cx, cz, foldSalt(species.id, Attr.ROT_Y, slot));
    const colorT = hashCell(REEF_WORLD_SEED, cx, cz, foldSalt(species.id, Attr.COLOR, slot));
    const tiltX = lerp(-0.12, 0.12, hashCell(REEF_WORLD_SEED, cx, cz, foldSalt(species.id, Attr.TILT_X, slot)));
    const tiltZ = lerp(-0.12, 0.12, hashCell(REEF_WORLD_SEED, cx, cz, foldSalt(species.id, Attr.TILT_Z, slot)));
    const axJ = (attr: number): number => lerp(0.82, 1.18, hashCell(REEF_WORLD_SEED, cx, cz, foldSalt(species.id, attr, slot)));

    let rotY = rotRoll * Math.PI * 2;
    if (species.id === 'seaFan') {
      // Orient broadside to the local cross-shore axis, with a gentle natural jitter around it
      // rather than a perfectly uniform fence of fans — see crossShoreNormal's header.
      const [nx, nz] = crossShoreNormal(x);
      rotY = Math.atan2(nx, nz) + lerp(-0.35, 0.35, rotRoll);
    }

    out.push({
      species: species.id,
      x, y: reefGroundY(x, z), z,
      rotY, tiltX, tiltZ,
      scaleX: baseScale * axJ(Attr.SCALE_X),
      scaleY: baseScale * axJ(Attr.SCALE_Y),
      scaleZ: baseScale * axJ(Attr.SCALE_Z),
      colorT,
    });
  }
  return out;
}

/**
 * Full placement for one chunk, across every species in `speciesList` (defaults to the full
 * roster). The `speciesList` parameter exists so the determinism test can call this with a
 * species removed/added and assert every *other* species' output is untouched — see this
 * module's header.
 */
export function placeChunk(cx: number, cz: number, speciesList: SpeciesDef[] = SPECIES_LIST): Partial<ChunkPlacement> {
  const result: Partial<ChunkPlacement> = {};
  for (const species of speciesList) {
    result[species.id] = placeSpeciesInChunk(species, cx, cz);
  }
  return result;
}
