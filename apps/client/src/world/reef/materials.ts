/**
 * One cached THREE.Material per (species, style) — shared across every InstancedMesh of that
 * species at every LOD that uses that style, with actual per-instance colour coming entirely
 * from `InstancedMesh.setColorAt` (see chunk-manager.ts), the same pattern world/coral.ts,
 * world/islands.ts and world/landmarks.ts already use: base material colour stays white, the
 * instance colour buffer does the work.
 */
import * as THREE from 'three';
import type { SpeciesDef } from './species.js';
import { polypNormalTex, lacyAlphaTex, bladeAlphaTex } from './textures.js';

export type MaterialStyle = 'solid' | 'card';

const _cache = new Map<string, THREE.MeshStandardMaterial>();

/** Polyp-bump frequency/strength per species — star coral's corallites are smaller/denser and
 * more pronounced than brain coral's broad smooth ridges; sponges get a subtler, coarser texture. */
function polypParamsFor(id: SpeciesDef['id']): { freq: number; strength: number } {
  switch (id) {
    case 'star': return { freq: 10, strength: 1.35 };
    case 'brain': return { freq: 5, strength: 0.7 };
    case 'barrelSponge': return { freq: 4, strength: 0.5 };
    case 'tubeSponge': return { freq: 4.5, strength: 0.55 };
    case 'encrusting': return { freq: 7, strength: 0.9 };
    default: return { freq: 6, strength: 0.75 };
  }
}

export function materialFor(species: SpeciesDef, style: MaterialStyle): THREE.MeshStandardMaterial {
  const key = `${species.id}:${style}`;
  const cached = _cache.get(key);
  if (cached) return cached;

  let mat: THREE.MeshStandardMaterial;
  if (style === 'card') {
    mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: species.id === 'seagrass' ? bladeAlphaTex() : lacyAlphaTex(),
      alphaTest: 0.45,
      side: THREE.DoubleSide,
      roughness: 0.95,
    });
  } else {
    const { freq, strength } = polypParamsFor(species.id);
    mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      flatShading: true,
      roughness: 0.92,
      normalMap: polypNormalTex(freq, strength),
      normalScale: new THREE.Vector2(0.6, 0.6),
    });
  }
  _cache.set(key, mat);
  return mat;
}
