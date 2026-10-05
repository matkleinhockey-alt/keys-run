/**
 * Wet-fish skin material, shared by every place a fish is shown close up and still: the catch
 * portrait (game/catch/portrait.ts), the underwater trophy card (game/catch/underwater-trophy.ts)
 * and the hooked-fish/photo rig (game/fishing/fish-mesh.ts).
 *
 * ## Why this exists
 *
 * A fish held up to the camera is the one moment the player actually *looks* at a fish, and the
 * two things that sell it are both material-level, not geometry-level (entities/fish/body.ts and
 * fins.ts already give the right silhouette):
 *
 *  1. **Wet skin.** A fish just out of the water is glossy and slightly iridescent. A plain
 *     `MeshStandardMaterial` at roughness 0.4 reads as dry matte plastic no matter how good the
 *     shape is. Clearcoat supplies the thin wet film; a little iridescence supplies the oil-slick
 *     sheen that fish scales actually have.
 *  2. **Scales.** Fish skin is not smooth. Without some surface break-up a lofted hull reads as a
 *     vinyl balloon under a specular highlight — the highlight is one clean unbroken blob, which
 *     is the single biggest "this is CG" tell at this distance.
 *
 * ## Scales without UVs
 *
 * `buildCreatureGeo` merges a dozen primitives (lathe hull, shape-geometry fins, sphere eyes) and
 * recomputes normals; their UV sets are inherited piecemeal from those primitives and do not form
 * one coherent body-space parameterisation. Rather than invent a UV unwrap for a merged hull, the
 * scale pattern is generated **from object-space position** in the shader (`onBeforeCompile`), so
 * it needs no UVs at all and cannot seam.
 *
 * The pattern perturbs only the *normal* (and nudges roughness), never the position — so it costs
 * no geometry, cannot change the silhouette, and degrades to "slightly rougher skin" rather than
 * to visible artefacts if a species' proportions are unusual. Rows run around the body's
 * circumference and march along its length, offset every other row, which is how real scale rows
 * sit; `SCALE_DENSITY` is in rows per metre of body, so a 20 cm yellowtail and a 1.7 m tarpon both
 * get believably-sized scales instead of the same pattern stretched.
 *
 * Fins and eyes are part of the same merged mesh and therefore get the same treatment; the effect
 * is subtle enough there that masking it off is not worth a second material and another draw call.
 */
import * as THREE from 'three';

/** Scale rows per metre of body length. ~45/m puts roughly 2 cm scales on a mid-size snapper,
 * which is about right; much denser and it aliases into noise at portrait distance. */
const SCALE_DENSITY = 45;

/** How hard the scale pattern bends the normal. Deliberately small — this is surface break-up to
 * stop the specular highlight reading as one unbroken blob, not embossed armour plating. */
const SCALE_RELIEF = 0.055;

export interface WetFishOptions {
  /** Body length in metres — scales the pattern so every species gets similarly-sized scales. */
  lengthM?: number;
  /** Set false for the distant//moving cases where the scale shader isn't worth the compile. */
  scales?: boolean;
}

/**
 * `vertexColors` is ON by default and must stay on: entities/fish/body.ts's `bodyColor` bakes
 * countershading (dark dorsal, pale belly), shark banding and species patterning into the vertex
 * colour attribute. A material that omits it renders the fish in one flat species colour — which
 * is exactly the bug this module was written to fix in the catch portrait, where a mahi came out
 * as a uniform neon-green blank.
 */
export function makeWetFishMaterial(color: THREE.ColorRepresentation, opts: WetFishOptions = {}): THREE.MeshPhysicalMaterial {
  const { lengthM = 1, scales = true } = opts;

  const mat = new THREE.MeshPhysicalMaterial({
    color,
    vertexColors: true,
    roughness: 0.3,
    metalness: 0.08,
    // The thin film of water still on the fish. High clearcoat, low clearcoat roughness: a tight
    // bright highlight sitting *above* the diffuse body colour, which is what "wet" looks like.
    clearcoat: 0.8,
    clearcoatRoughness: 0.14,
    // Scales are thin-film structures; real ones go faintly rainbow at grazing angles.
    iridescence: 0.3,
    iridescenceIOR: 1.32,
    iridescenceThicknessRange: [120, 420],
    envMapIntensity: 1.2,
    sheen: 0.25,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(0x9fd4e8),
  });

  if (scales) applyScaleShader(mat, lengthM);
  return mat;
}

/**
 * Injects the object-space scale pattern into an existing physical/standard material. Exposed
 * separately so a caller that already has a tuned material (the portrait's own clone) can gain
 * scales without giving up its other settings.
 */
export function applyScaleShader(mat: THREE.Material, lengthM: number): void {
  const freq = SCALE_DENSITY * Math.max(0.05, lengthM);

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uScaleFreq = { value: freq };
    shader.uniforms.uScaleRelief = { value: SCALE_RELIEF };

    // Object-space position, so the pattern is locked to the body and does not swim across the
    // surface as the fish is rotated on the turntable.
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFishObjPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vFishObjPos = position;');

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vFishObjPos;
uniform float uScaleFreq;
uniform float uScaleRelief;

// Offset rows of overlapping scales. x = around the body (from the atan of the cross-section),
// y = along it. Every other row is shifted half a scale, as real scale rows are.
vec2 fishScaleCell(vec3 p) {
  float around = atan(p.y, p.x) / 6.2831853;   // -0.5..0.5 around the body axis
  float along  = p.z;
  float row    = floor(along * uScaleFreq);
  float stagger = mod(row, 2.0) * 0.5;
  return vec2(fract(around * uScaleFreq * 0.35 + stagger), fract(along * uScaleFreq));
}`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
{
  vec2 cell = fishScaleCell(vFishObjPos);
  // Distance from the centre of the scale, shaped so each scale reads as a shallow convex lens
  // with a crisp trailing edge — the free margin of a real scale overlaps the one behind it.
  vec2 d = cell - 0.5;
  float lens = 1.0 - smoothstep(0.18, 0.5, length(d * vec2(1.0, 1.35)));
  // Gradient of that lens field, used directly as a tangent-space normal tilt. Cheap finite
  // difference in cell space rather than a texture fetch.
  vec2 tilt = d * lens * 2.0;
  vec3 bumped = normalize(normal + uScaleRelief * (tilt.x * vec3(1.0, 0.0, 0.0) + tilt.y * vec3(0.0, 1.0, 0.0)));
  normal = bumped;
  // Scale edges hold a little more water than their centres, so they read slightly glossier.
  roughnessFactor *= 1.0 - 0.18 * lens;
}`,
      );
  };
  // Force a recompile if this material was already used this frame.
  mat.needsUpdate = true;
}
