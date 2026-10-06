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
import { uFlow, uSurgeAxis, uSurgePhase, uSurgeAmp } from './flow.js';

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
    // Rigid species reaching this branch are elkhorn/staghorn's *far* impostor cards
    // (chunk-manager.ts's FAR_SWITCHES_TO_CARD) — a stony coral must not sway just because its
    // distant stand-in happens to be a quad, so the shader is only compiled in above zero.
    if (species.flexibility > 0) attachSway(mat, species.flexibility);
  } else if (species.id === 'brain' || species.id === 'star') {
    // Smooth-shaded (not flatShading) — a faceted low-poly boulder reads as a cut gemstone/rock;
    // these two specifically need to read as a soft, living, grooved mass (see this module's
    // report: "boulders have no groove texture, so they read as geology, not biology").
    const { freq, strength } = grooveParamsFor(species.id);
    mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      flatShading: false,
      // vertexColors multiplies geometry.ts's per-vertex `color` attribute (paintVertexColors) in
      // on top of the per-instance colour: a subtle persistent mottle so one instance never reads
      // as one flat swatch, plus a darkened/grounded blend near the boulder's own base so it reads
      // as settling into the substrate rather than a slab sitting on top of it (this module's
      // report: "no colour variation within a single coral head" / "slabs appear to hover").
      vertexColors: true,
      roughness: 0.82,
      // Raised from 1.1: under the game's real lighting (soft hemisphere-dominated ambient, not
      // the harness's single hard directional sun) a shallower normal scale reads as almost flat —
      // see this module's report's harness-vs-real-game comparison.
      normalMap: grooveNormalTex(freq, strength),
      normalScale: new THREE.Vector2(1.6, 1.6),
    });
  } else {
    const { freq, strength } = polypParamsFor(species.id);
    mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      // Smooth, not flatShading: a hard-faceted low-poly branch/boulder reads as cut wood/rock —
      // every "solid" reef species needs to read as a soft living organism, not just brain/star
      // (see this module's report). The normal map still carries the surface micro-detail.
      flatShading: false,
      vertexColors: true, // see the brain/star branch's comment above — same technique, all solid species.
      roughness: 0.85,
      normalMap: polypNormalTex(freq, strength),
      normalScale: new THREE.Vector2(0.95, 0.95),
    });
  }
  _cache.set(key, mat);
  return mat;
}

/**
 * Current-driven sway for the flexible card species (seagrass, sea plumes, sea fans).
 *
 * Two superposed motions, which is what separates water from wind:
 *
 *  - A **steady lean** into the Florida Current / tide (`uFlow`). Weeds in a real current do not
 *    oscillate about vertical; they sit over, permanently, pointing downstream, and only the
 *    amount changes as the tide turns. This is the part that makes the Gulf Stream legible from
 *    inside the water — out on the wall the grass is pinned flat, inshore at slack it stands up.
 *  - A **surge oscillation** across the reef line (`uSurgeAxis`/`uSurgePhase`/`uSurgeAmp`), the
 *    back-and-forth of wave orbital motion. Its phase is offset per instance by the instance's own
 *    world position projected on the surge axis, so a bed rocks as a wave rolls over it instead of
 *    twitching in lockstep — the same travelling-wave term `surgeAt` carries on the CPU side.
 *
 * Both scale by the `flex` attribute baked into the card geometry (geometry.ts): `t*t` up the
 * blade, so the base stays rooted and the tip does the travelling. The vertical shortening term
 * conserves apparent length — a blade bent 60 degrees over is not as tall as an upright one, and
 * without it the whole bed visibly grows as the current picks up.
 */
function attachSway(mat: THREE.MeshStandardMaterial, flexibility: number): void {
  const uniforms = {
    uFlow, uSurgeAxis, uSurgePhase, uSurgeAmp,
    uFlex: { value: flexibility },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float flex;
uniform vec2 uFlow; uniform vec2 uSurgeAxis; uniform float uSurgePhase; uniform float uSurgeAmp;
uniform float uFlex;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  #ifdef USE_INSTANCING
    vec3 wRoot = instanceMatrix[3].xyz;
  #else
    vec3 wRoot = vec3(0.0);
  #endif
  // Travelling-wave phase: 34 m wavelength along the cross-shore axis, matching surgeAt.
  float sPh = uSurgePhase - dot(wRoot.xz, uSurgeAxis) * ${(Math.PI * 2 / 34).toFixed(8)};
  vec2 surge = uSurgeAxis * (sin(sPh) * uSurgeAmp);
  // Steady lean saturates — past about a knot a blade is already flat and cannot lie down
  // further, so an unbounded term would shear it through the seafloor.
  vec2 lean = uFlow / (1.0 + length(uFlow) * 0.75);
  vec2 bend = (lean + surge) * uFlex * flex;
  transformed.xz += bend;
  // Shorten vertically as it leans over, so apparent blade length is conserved.
  transformed.y -= length(bend) * flex * 0.45;
}`);
  };
  mat.customProgramCacheKey = (): string => `reefSway:${flexibility}`;
  mat.needsUpdate = true;
}
