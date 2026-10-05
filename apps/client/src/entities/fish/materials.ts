/**
 * PBR fish material: samples the baked VAT (vat.ts) for swim animation, then reproduces legacy
 * `addSwimShader`'s fragment effects (index.html:2440-2475 — procedural overlapping scales, a
 * lateral line, countershading, a depth-haze fresnel rim) on top of a real PBR base instead of
 * legacy's flat `MeshStandardMaterial({roughness:.3,metalness:.28})` shared by every species.
 *
 * Upgrades beyond the port (docs/ARCHITECTURE.md task brief item 1, "Upgrade materials to PBR"):
 *  - `MeshPhysicalMaterial` per species, so roughness/metalness/iridescence can differ by species
 *    (legacy used one shared material for all 49) — see `pbrParamsFor`.
 *  - The scale-edge/lateral-line fields legacy computed only to tint `diffuseColor` now also
 *    perturb `roughnessFactor` (scale ridges read slightly matte, the lateral line slightly
 *    glossy) and the shading normal (via screen-space derivatives of the scale field — a bump
 *    map with no texture, no UVs, and no extra geometry, since the procedural pattern is already
 *    being computed for colour). `material.extensions.derivatives = true` is required for the
 *    `dFdx`/`dFdy` calls.
 *  - Iridescence (three's native `iridescence`/`iridescenceIOR`) on species whose real scales
 *    actually shimmer (tuna, jacks, mackerel, mahi) — near zero on matte reef/bottom species.
 *
 * legacy's per-vertex `scl`/`shn` attributes (constant across one geometry — see swim.ts) become
 * plain uniforms (`uScl`/`uShn`) here instead of a wasted per-vertex buffer.
 */
import * as THREE from 'three';
import type { CreatureVis } from '@keysrun/shared/content/creatures';
import type { VatBake } from './vat.js';
import { swimClock } from './swim-clock.js';

interface PbrParams {
  roughness: number;
  metalness: number;
  iridescence: number;
  iridescenceIOR: number;
}

const SHINY = new Set(['yellowfin', 'bluefin', 'albacore', 'blackfin', 'amberjack', 'jackcrevalle', 'pompano', 'kingfish', 'cero', 'wahoo', 'mahi', 'cobia', 'permit', 'bonefish', 'ladyfish', 'tarpon']);
const MATTE = new Set(['grouper', 'gag', 'redgrouper', 'goliath', 'nurse', 'lionfish', 'hogfish', 'tripletail', 'manatee']);

/** Species-appropriate PBR tuning — legacy had exactly one material for all 49 species
 * (`roughness:.3,metalness:.28`, no iridescence support in r128's MeshStandardMaterial anyway). */
function pbrParamsFor(key: string, V: CreatureVis): PbrParams {
  if (V.kind === 'ray' || V.kind === 'turtle' || V.kind === 'manatee') return { roughness: 0.75, metalness: 0.02, iridescence: 0, iridescenceIOR: 1.3 };
  if (V.kind === 'shark') return { roughness: 0.55, metalness: 0.08, iridescence: 0.08, iridescenceIOR: 1.4 };
  if (V.kind === 'dolphin') return { roughness: 0.3, metalness: 0.05, iridescence: 0.1, iridescenceIOR: 1.4 };
  // Whales: big, wet, matte-ish skin (scarring/barnacles on a humpback, satin-smooth on a pilot
  // whale) — less glossy than a dolphin's rubbery sheen, no iridescence at all.
  if (V.kind === 'whale') return { roughness: 0.42, metalness: 0.03, iridescence: 0, iridescenceIOR: 1.3 };
  if (MATTE.has(key)) return { roughness: 0.68, metalness: 0.05, iridescence: 0.02, iridescenceIOR: 1.3 };
  if (SHINY.has(key) || V.kind === 'tuna') return { roughness: 0.22, metalness: 0.35, iridescence: 0.55, iridescenceIOR: 1.45 };
  return { roughness: 0.35, metalness: 0.22, iridescence: 0.18, iridescenceIOR: 1.35 };
}

const TWO_PI = Math.PI * 2;

export function createFishMaterial(key: string, V: CreatureVis, vat: VatBake, uScl: number, uShn: number): THREE.MeshPhysicalMaterial {
  const pbr = pbrParamsFor(key, V);
  const mat = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: pbr.roughness,
    metalness: pbr.metalness,
    iridescence: pbr.iridescence,
    iridescenceIOR: pbr.iridescenceIOR,
    iridescenceThicknessRange: [100, 380],
  });
  // (no `material.extensions.derivatives` flag needed: r186 dropped WebGL1 entirely, and
  // dFdx/dFdy — used below for the derivative-based normal bump — are core GLSL ES3/WebGL2.)

  const axisField = vat.axis === 'x' ? 'x' : 'y';
  const uniforms = {
    uSwimT: swimClock,
    uVat: { value: vat.texture },
    uVatW: { value: vat.vertexCount },
    uVatH: { value: vat.frameCount },
    uAngSpeed: { value: vat.angSpeed },
    uScl: { value: uScl },
    uShn: { value: uShn },
  };

  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);

    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float vIdx;
attribute float iPhase;
uniform sampler2D uVat; uniform float uVatW; uniform float uVatH; uniform float uSwimT; uniform float uAngSpeed;
varying vec3 vFP; varying float vWY;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
    vFP = position;
    float swTheta = mod(uSwimT * uAngSpeed + iPhase, ${TWO_PI.toFixed(10)});
    float swFrame = swTheta / ${TWO_PI.toFixed(10)} * uVatH;
    float swF0 = floor(swFrame);
    float swF1 = mod(swF0 + 1.0, uVatH);
    float swTt = swFrame - swF0;
    float swU = (vIdx + 0.5) / uVatW;
    float swD0 = texture2D(uVat, vec2(swU, (swF0 + 0.5) / uVatH)).r;
    float swD1 = texture2D(uVat, vec2(swU, (swF1 + 0.5) / uVatH)).r;
    float swD = mix(swD0, swD1, swTt);
    transformed.${axisField} += swD;
    #ifdef USE_INSTANCING
      vec4 swWpp = instanceMatrix * vec4(transformed, 1.0);
    #else
      vec4 swWpp = vec4(transformed, 1.0);
    #endif
    vWY = (modelMatrix * swWpp).y;`);

    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vFP; varying float vWY;
uniform float uScl; uniform float uShn;
float gScaleEdge = 0.0;
float gLatLine = 0.0;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
    if (uScl > 0.0) {
      // overlapping scales: rows of rounded scale edges, finer toward the tail. Legacy's "side"
      // factor multiplied this by a term that always evaluated to 1 (the only variable part was
      // zeroed by a stray *.0), so it is dropped here rather than ported as dead arithmetic.
      float k = 46.0 / uScl; vec2 q = vec2(vFP.z * k, vFP.y * k * 1.25); q.x += 0.5 * mod(floor(q.y), 2.0);
      vec2 f = fract(q) - vec2(0.5, 0.15); float r = length(f * vec2(1.0, 1.4));
      gScaleEdge = smoothstep(0.36, 0.5, r) * (1.0 - smoothstep(0.5, 0.62, r));
      diffuseColor.rgb *= 1.0 - 0.16 * gScaleEdge;
      // lateral line running down the flank
      float ll = abs(vFP.y - uScl * 0.02 * (1.0 - abs(vFP.z / uScl) * 1.6));
      gLatLine = (1.0 - smoothstep(0.0, uScl * 0.006 + 0.002, ll)) * step(abs(vFP.z), uScl * 0.42);
      diffuseColor.rgb *= 1.0 - 0.22 * gLatLine;
    }
    // countershading: darker back, brighter belly
    diffuseColor.rgb *= 0.86 + 0.24 * smoothstep(-0.6, 0.6, -vFP.y / (abs(vFP.y) + 0.05));`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
    roughnessFactor = clamp(roughnessFactor + 0.18 * gScaleEdge - 0.10 * gLatLine, 0.03, 1.0);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
    normal = normalize(normal + vec3(dFdx(gScaleEdge), dFdy(gScaleEdge), 0.0) * 0.5);`)
      .replace('#include <dithering_fragment>', `
    float fres = pow(1.0 - abs(dot(normalize(normal), normalize(vViewPosition))), 3.0);
    float dpt = max(0.0, -vWY - 0.3); float haze = 1.0 - exp(-dpt * 0.16);
    gl_FragColor.rgb += vec3(0.75, 0.85, 0.95) * fres * 0.28 * uShn * (1.0 - haze);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.03, 0.22, 0.30), min(0.96, haze));
    #include <dithering_fragment>`);
  };
  // Force a fresh program on first compile (onBeforeCompile already runs on first compile; this
  // just documents that re-assigning onBeforeCompile later — e.g. a quality-tier swap rebuilding
  // materials — must bump needsUpdate, same convention as core/shadows.ts).
  mat.needsUpdate = true;
  return mat;
}
