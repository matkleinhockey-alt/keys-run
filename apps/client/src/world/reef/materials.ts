/**
 * One cached THREE.Material per (species, style) — shared across every InstancedMesh of that
 * species at every LOD that uses that style, with actual per-instance colour coming entirely
 * from `InstancedMesh.setColorAt` (see chunk-manager.ts), the same pattern world/coral.ts,
 * world/islands.ts and world/landmarks.ts already use: base material colour stays white, the
 * instance colour buffer does the work.
 */
import * as THREE from 'three';
import type { SpeciesDef } from './species.js';
import { polypNormalTex, grooveNormalTex, lacyAlphaTex, fanAlphaTex, bladeAlphaTex } from './textures.js';

export type MaterialStyle = 'solid' | 'card';

const _cache = new Map<string, THREE.MeshStandardMaterial>();

/** Polyp-bump frequency/strength per species — star coral's corallites are smaller/denser and
 * more pronounced than brain coral's broad smooth ridges; sponges get a subtler, coarser texture.
 * Brain/star don't use this — see `materialFor`, they get `grooveNormalTex` instead. */
function polypParamsFor(id: SpeciesDef['id']): { freq: number; strength: number } {
  switch (id) {
    case 'barrelSponge': return { freq: 4, strength: 0.5 };
    case 'tubeSponge': return { freq: 4.5, strength: 0.55 };
    case 'encrusting': return { freq: 7, strength: 0.9 };
    default: return { freq: 6, strength: 0.75 };
  }
}

/** Brain/star coral's defining feature is long meandering grooves, not fine polyp grain — see
 * grooveNormalTex's header. Star's corallites are smaller/denser than brain's broader ridges. */
function grooveParamsFor(id: SpeciesDef['id']): { freq: number; strength: number } {
  return id === 'star' ? { freq: 13, strength: 1.5 } : { freq: 8, strength: 1.3 };
}

export function materialFor(species: SpeciesDef, style: MaterialStyle): THREE.MeshStandardMaterial {
  const key = `${species.id}:${style}`;
  const cached = _cache.get(key);
  if (cached) return cached;

  let mat: THREE.MeshStandardMaterial;
  if (style === 'card') {
    const map = species.id === 'seagrass' ? bladeAlphaTex() : species.id === 'seaFan' ? fanAlphaTex() : lacyAlphaTex();
    mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
      roughness: 0.9,
    });
  } else if (species.id === 'brain' || species.id === 'star') {
    // Smooth-shaded (not flatShading) — a faceted low-poly boulder reads as a cut gemstone/rock;
    // these two specifically need to read as a soft, living, grooved mass (see this module's
    // report: "boulders have no groove texture, so they read as geology, not biology").
    const { freq, strength } = grooveParamsFor(species.id);
    mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      flatShading: false,
      roughness: 0.88,
      normalMap: grooveNormalTex(freq, strength),
      normalScale: new THREE.Vector2(1.1, 1.1),
    });
  } else {
    const { freq, strength } = polypParamsFor(species.id);
    mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      // Smooth, not flatShading: a hard-faceted low-poly branch/boulder reads as cut wood/rock —
      // every "solid" reef species needs to read as a soft living organism, not just brain/star
      // (see this module's report). The normal map still carries the surface micro-detail.
      flatShading: false,
      roughness: 0.92,
      normalMap: polypNormalTex(freq, strength),
      normalScale: new THREE.Vector2(0.6, 0.6),
    });
  }
  _cache.set(key, mat);
  return mat;
}
