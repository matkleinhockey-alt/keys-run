/**
 * The town's shared materials, and how the lit ones plug into the existing day/night system.
 *
 * `core/time-of-day.ts` owns one mechanism for things that glow at night: a `lightMats` list of
 * `{ m, day, night }`, and every time the sky blend moves it lerps each `m.opacity` between the two.
 * Nothing about it is boat-specific, so the town uses it as-is. Every emissive thing in the town —
 * lit windows, neon, lamp halos, pools of light on the pavement — is an additive, transparent
 * material registered here, which means:
 *
 *   - there is no per-frame lighting code in the town at all (the sky blend already runs);
 *   - a lit sign costs one material, not one light, so 30 neon signs are free;
 *   - the only real `PointLight`s are the handful in `lights.ts`, and those exist purely to put
 *     warm light on the people and cars standing next to a lamp.
 *
 * New materials are created with their opacity already at the CURRENT blend (`todK`), not the day
 * value: the town builds lazily, possibly mid-sunset, and `applyTOD` will not run again until the
 * blend moves.
 */
import * as THREE from 'three';
import type { LightMatEntry } from '../../core/time-of-day.js';
import { lerp } from '../../core/math.js';
import { radialGlowTexture, plankTexture } from './paint.js';

export interface TownKit {
  /** Vertex-coloured, flat-shaded: walls, kerbs, furniture, palms. */
  solid: THREE.MeshStandardMaterial;
  /** Same, but glossy: car bodies and chrome. */
  car: THREE.MeshStandardMaterial;
  /** Additive radial halos and light pools, tinted by vertex colour. Night only. */
  glowQuad: THREE.MeshBasicMaterial;
  radial: THREE.Texture;
  plank: THREE.Texture;
  /** A facade decal: textured, alpha-cut (doorways), pulled toward the camera so it never z-fights the wall behind. */
  decal(map: THREE.Texture): THREE.MeshStandardMaterial;
  /** A lit overlay: additive, fades in with the sunset. */
  glowDecal(map: THREE.Texture, night?: number): THREE.MeshBasicMaterial;
  /** An unlit emissive flat colour (spotlight beams, bulbs). */
  glowFlat(color: number, night: number): THREE.MeshBasicMaterial;
  dispose(): void;
}

export function createKit(lightMats: LightMatEntry[], todK: () => number): TownKit {
  const owned: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const registered: LightMatEntry[] = [];
  const own = <T extends THREE.Material>(m: T): T => { owned.push(m); return m; };
  const register = <T extends THREE.Material & { opacity: number }>(m: T, day: number, night: number): T => {
    m.opacity = lerp(day, night, todK());
    const e: LightMatEntry = { m, day, night };
    lightMats.push(e); registered.push(e);
    return own(m);
  };

  const radial = radialGlowTexture(), plank = plankTexture();
  textures.push(radial, plank);

  // (Shade compensation is baked into the vertex colours, see GeoBatch's `lift`: a flat emissive floor
  // was tried here and washed the dark colours grey.)
  const solid = own(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.88, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  const car = own(new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.32, metalness: 0.45 }));
  const glowQuad = register(new THREE.MeshBasicMaterial({
    map: radial, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  }), 0, 1);

  return {
    solid, car, glowQuad, radial, plank,
    decal(map) {
      textures.push(map);
      return own(new THREE.MeshStandardMaterial({ map, alphaTest: 0.5, roughness: 0.8, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.42, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    },
    glowDecal(map, night = 1) {
      textures.push(map);
      return register(new THREE.MeshBasicMaterial({
        map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }), 0, night);
    },
    glowFlat(color, night) {
      return register(new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }), 0, night);
    },
    dispose() {
      // Leave no dead entries behind: `applyTOD` would keep writing opacity into disposed materials forever.
      for (const e of registered) { const i = lightMats.indexOf(e); if (i >= 0) lightMats.splice(i, 1); }
      owned.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
    },
  };
}
