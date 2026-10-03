/**
 * Procedural LOD geometry for all ten reef species — requirement 4: "no downloaded assets...
 * build convincing coral procedurally now (branching structures, encrusting forms, polyp detail
 * via normal maps)". One geometry is built per (species, LOD) at module load and shared by every
 * instance of that species at that LOD through InstancedMesh (see chunk-manager.ts) — this file
 * only ever constructs geometry, never per-instance transforms.
 *
 * Three LOD tiers ("full geometry near, simplified mid, billboard/impostor far" —
 * docs/ARCHITECTURE.md "Reef"): the four branching/massive coral species (elkhorn, staghorn,
 * brain, star) get a genuine 3-way geometric simplification, since their volumetric silhouette is
 * what sells "coral" up close. Sea fans/plumes and seagrass are naturally near-planar in life, so
 * their "full" geometry is already a (lacy, alpha-cut) card at every tier — not a cop-out LOD,
 * just the right representation for a flat organism. Sponges keep a true (cheaper) LatheGeometry
 * at all three tiers rather than flattening to a card, because a barrel/tube silhouette reads
 * wrong as a flat cutout from any angle other than face-on. See this module's report for the
 * measured triangle counts this produced.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '@keysrun/shared/rng';
import type { SpeciesId } from './types.js';

export interface LodGeometry {
  near: THREE.BufferGeometry;
  mid: THREE.BufferGeometry;
  far: THREE.BufferGeometry;
}

function disposeAll(parts: THREE.BufferGeometry[]): void {
  for (const p of parts) p.dispose();
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false) ?? new THREE.BufferGeometry();
  g.computeVertexNormals();
  disposeAll(parts);
  return g;
}

// ---------------------------------------------------------------------------
// Branching corals (elkhorn, staghorn) — a small recursive branch tree, merged into one geometry.
// ---------------------------------------------------------------------------

function branchSegment(length: number, baseR: number, tipR: number, radial: number, flatX: number, flatZ: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(tipR, baseR, length, radial, 1);
  g.translate(0, length / 2, 0);
  g.scale(flatX, 1, flatZ);
  return g;
}

interface BranchOpts {
  seed: number;
  depth: number;
  branchFactor: number;
  radial: number;
  baseLength: number;
  baseRadius: number;
  spread: number;
  flatX: number;
  flatZ: number;
  lengthFalloff: number;
  radiusFalloff: number;
}

function branchingCoral(opts: BranchOpts): THREE.BufferGeometry {
  const rng = mulberry32(opts.seed);
  const parts: THREE.BufferGeometry[] = [];

  const grow = (mat: THREE.Matrix4, length: number, radius: number, depth: number, branchFactor: number): void => {
    const seg = branchSegment(length, radius, radius * 0.6, opts.radial, opts.flatX, opts.flatZ);
    seg.applyMatrix4(mat);
    parts.push(seg);
    if (depth <= 0) return;
    const tip = mat.clone().multiply(new THREE.Matrix4().makeTranslation(0, length, 0));
    for (let i = 0; i < branchFactor; i++) {
      const yaw = (i / branchFactor) * Math.PI * 2 + rng() * 1.1;
      const tilt = opts.spread * (0.55 + rng() * 0.5);
      const m = tip.clone()
        .multiply(new THREE.Matrix4().makeRotationY(yaw))
        .multiply(new THREE.Matrix4().makeRotationZ(tilt));
      const nextFactor = Math.max(1, branchFactor - (rng() < 0.4 ? 1 : 0));
      grow(m, length * opts.lengthFalloff, radius * opts.radiusFalloff, depth - 1, nextFactor);
    }
  };

  grow(new THREE.Matrix4(), opts.baseLength, opts.baseRadius, opts.depth, opts.branchFactor);
  return merge(parts);
}

function elkhornGeo(lod: 'near' | 'mid'): THREE.BufferGeometry {
  // Flattened "antler" paddles (flatX wide, flatZ thin) — Acropora palmata's defining silhouette.
  return branchingCoral({
    seed: 0xe1f0a, depth: lod === 'near' ? 2 : 1, branchFactor: 3, radial: lod === 'near' ? 5 : 4,
    baseLength: 0.85, baseRadius: 0.22, spread: 0.85, flatX: 2.3, flatZ: 0.45,
    lengthFalloff: 0.68, radiusFalloff: 0.72,
  });
}

function staghornGeo(lod: 'near' | 'mid'): THREE.BufferGeometry {
  // Round, thin, deeply recursive — a dense thicket of antler branches.
  return branchingCoral({
    seed: 0x57a6, depth: lod === 'near' ? 3 : 2, branchFactor: 2, radial: lod === 'near' ? 5 : 4,
    baseLength: 0.62, baseRadius: 0.085, spread: 0.72, flatX: 1, flatZ: 1,
    lengthFalloff: 0.74, radiusFalloff: 0.78,
  });
}

// ---------------------------------------------------------------------------
// Massive boulder corals (brain, star) — a flattened, noise-displaced icosahedron.
// ---------------------------------------------------------------------------

function hashN(i: number, seed: number): number {
  const h = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return h - Math.floor(h);
}

/** Pushes each vertex outward along its own (already-normalized-ish) position by a per-vertex
 * noise amount — turns a perfect icosahedron into an irregular boulder with rounded lumps
 * standing in for brain coral's ridges / star coral's knobbier corallite heads. */
function displaceBoulder(geo: THREE.BufferGeometry, amp: number, freq: number, seed: number): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = hashN(Math.floor(v.x * freq) + Math.floor(v.y * freq) * 7 + Math.floor(v.z * freq) * 13, seed);
    const bump = 1 + (n - 0.5) * 2 * amp;
    v.multiplyScalar(bump);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function brainGeo(detail: 0 | 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  g.scale(1, 0.56, 1); // smooth, flattened dome
  if (detail === 1) displaceBoulder(g, 0.1, 2.2, 11);
  return g;
}

function starGeo(detail: 0 | 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  g.scale(1, 0.72, 1); // chunkier boulder than brain coral
  if (detail === 1) displaceBoulder(g, 0.18, 3.1, 29);
  return g;
}

function encrustingGeo(detail: 0 | 1): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail);
  g.scale(1, 0.24, 1); // low plate/encrusting mound filling gaps between heads
  if (detail === 1) displaceBoulder(g, 0.14, 4, 47);
  return g;
}

// ---------------------------------------------------------------------------
// Flat/lacy organisms (sea fan, sea plume, seagrass) — alpha-cut cards; see textures.ts.
// ---------------------------------------------------------------------------

/** A single quad, pivoted at its bottom edge (so an instance's origin is its base on the
 * seafloor), optionally bent forward partway up for a soft droop (used by seagrass blades). */
function cardGeo(width: number, height: number, bendSegments = 1, bend = 0): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(width, height, 1, bendSegments);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) + height / 2; // 0 at base .. height at tip
    const t = height > 0 ? y / height : 0;
    pos.setZ(i, pos.getZ(i) + bend * t * t);
  }
  g.translate(0, height / 2, 0);
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Two cards crossed at 90 deg about Y, for a bushier look than one flat quad from every angle —
 * the classic cross-billboard trick used for foliage/soft coral. */
function crossCardGeo(width: number, height: number): THREE.BufferGeometry {
  const a = cardGeo(width, height);
  const b = cardGeo(width, height);
  b.rotateY(Math.PI / 2);
  return merge([a, b]);
}

function seaFanGeo(double: boolean): THREE.BufferGeometry {
  if (!double) return cardGeo(1.3, 1.1);
  const a = cardGeo(1.3, 1.1);
  const b = cardGeo(1.3, 1.1);
  b.translate(0, 0, 0.04);
  b.rotateY(0.25);
  return merge([a, b]);
}

function seaPlumeGeo(bushy: boolean): THREE.BufferGeometry {
  return bushy ? crossCardGeo(0.5, 1.3) : cardGeo(0.5, 1.3);
}

function seagrassGeo(blades: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < blades; i++) {
    const blade = cardGeo(0.1, 1, 3, 0.18 + (i % 2) * 0.08);
    blade.rotateY((i / blades) * Math.PI * 2);
    parts.push(blade);
  }
  return merge(parts);
}

// ---------------------------------------------------------------------------
// Sponges (barrel, tube) — THREE.LatheGeometry, true volumetric shape kept at every LOD (see
// this file's header for why a flat card is the wrong representation for these).
// ---------------------------------------------------------------------------

function barrelProfile(): THREE.Vector2[] {
  return [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.52, 0.04),
    new THREE.Vector2(0.78, 0.32),
    new THREE.Vector2(0.74, 0.74),
    new THREE.Vector2(0.52, 0.94),
    new THREE.Vector2(0.46, 1.0),
  ];
}

function barrelSpongeGeo(radial: number): THREE.BufferGeometry {
  return new THREE.LatheGeometry(barrelProfile(), radial);
}

function tubeProfile(): THREE.Vector2[] {
  return [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.22, 0.02),
    new THREE.Vector2(0.26, 0.85),
    new THREE.Vector2(0.21, 1.0),
    new THREE.Vector2(0.17, 1.0),
  ];
}

function tubeSpongeGeo(radial: number, count: number, seed: number): THREE.BufferGeometry {
  const rng = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const g = new THREE.LatheGeometry(tubeProfile(), radial);
    const h = 0.55 + rng() * 0.55;
    g.scale(1, h, 1);
    const ang = rng() * Math.PI * 2;
    const r = rng() * 0.22;
    g.translate(Math.cos(ang) * r, 0, Math.sin(ang) * r);
    parts.push(g);
  }
  return merge(parts);
}

// ---------------------------------------------------------------------------
// Public API: one LodGeometry set per species, built once and cached.
// ---------------------------------------------------------------------------

const _cache = new Map<SpeciesId, LodGeometry>();

export function geometryFor(species: SpeciesId): LodGeometry {
  const cached = _cache.get(species);
  if (cached) return cached;

  let set: LodGeometry;
  switch (species) {
    case 'elkhorn':
      set = { near: elkhornGeo('near'), mid: elkhornGeo('mid'), far: seaFanGeo(false) };
      break;
    case 'staghorn':
      set = { near: staghornGeo('near'), mid: staghornGeo('mid'), far: seaFanGeo(false) };
      break;
    case 'brain': {
      const mid = brainGeo(0);
      set = { near: brainGeo(1), mid, far: mid };
      break;
    }
    case 'star': {
      const mid = starGeo(0);
      set = { near: starGeo(1), mid, far: mid };
      break;
    }
    case 'encrusting': {
      const mid = encrustingGeo(0);
      set = { near: encrustingGeo(1), mid, far: mid };
      break;
    }
    case 'seaFan': {
      const far = seaFanGeo(false);
      set = { near: seaFanGeo(true), mid: seaFanGeo(true), far };
      break;
    }
    case 'seaPlume': {
      const far = seaPlumeGeo(false);
      set = { near: seaPlumeGeo(true), mid: seaPlumeGeo(true), far };
      break;
    }
    case 'barrelSponge':
      set = { near: barrelSpongeGeo(10), mid: barrelSpongeGeo(6), far: barrelSpongeGeo(4) };
      break;
    case 'tubeSponge':
      set = { near: tubeSpongeGeo(8, 4, 73), mid: tubeSpongeGeo(5, 3, 73), far: tubeSpongeGeo(4, 1, 73) };
      break;
    case 'seagrass': {
      const far = cardGeo(0.1, 1, 1, 0.1);
      set = { near: seagrassGeo(3), mid: seagrassGeo(3), far };
      break;
    }
  }
  _cache.set(species, set);
  return set;
}
