/**
 * Global per-channel underwater extinction — docs/ARCHITECTURE.md "The underwater world" →
 * "Rendering": water eats red first.
 *
 *   transmittance(rgb) = exp(-k_rgb * (distToCamera + cameraDepth))
 *   k_red ~= 0.45/m   k_green ~= 0.09/m   k_blue ~= 0.03/m
 *
 * Implemented by globally replacing `THREE.ShaderChunk.fog_fragment`, exactly as ARCHITECTURE.md
 * specifies, so every material that already opts into three's fog (MeshStandardMaterial,
 * MeshPhysicalMaterial, MeshLambertMaterial, MeshPhongMaterial, ... — `fog: true` is the default)
 * picks up depth-correct attenuation and inscatter automatically: coral, fish, hulls, terrain, all
 * of it, with zero changes to those materials. `installUnderwaterFog()` is called once from
 * game/world.ts's boot sequence, before anything is rendered.
 *
 * The trick that makes this a true *global*, zero-per-material-setup override: the only two
 * live, per-frame inputs the formula needs — which side of the surface the camera is on, and how
 * deep it is — both come for free from `cameraPosition`, three's own automatically-refreshed
 * world-space camera-position uniform that the `<common>` chunk already declares (and
 * WebGLRenderer already re-uploads every frame) for every one of these materials. No new uniform,
 * no per-material onBeforeCompile, nothing for any other agent's material to opt into.
 *
 * Degrading correctly above water (required by the brief): the override keeps three's *original*
 * linear/exp2 fog math verbatim for the "camera is above the surface" side of the blend, reading
 * the same `fogColor`/`fogNear`/`fogFar`/`fogDensity` uniforms scene.fog and core/quality.ts
 * already drive — so topside haze/draw-distance behaviour is completely unchanged. The two sides
 * are cross-faded over a small vertical band straddling y=0 (see depth-bands.ts's SURFACE_BAND)
 * rather than switched with a hard cut, which is what gives the ~0.3 s surface-crossing fog blend
 * ARCHITECTURE.md asks for — purely as a function of `cameraPosition.y`, no separate timer, so it
 * is correct even if the camera teleports (e.g. respawn, or a future multiplayer snap-correction).
 *
 * Known, deliberate approximations (documented rather than silently fudged):
 *  - Sea level is treated as the flat y=0 plane, not the true per-fragment rippled water height at
 *    the camera's xz. world/water.ts's wave displacement is a vertex-shader-only visual; sampling
 *    it here, for every material in the scene, would mean binding water's depth/normal textures
 *    globally — exactly the per-material coupling this design avoids. The few-centimetre ripple
 *    error is imperceptible against 0.45-0.03 /m extinction.
 *  - `distToCamera` reuses three's own `vFogDepth` (view-space -z, not true Euclidean distance) —
 *    the same approximation stock three.js fog already made; we did not make the model less
 *    accurate than what shipped before.
 *  - A material with `fog: false` (the sky dome, the sun disc — core/scene.ts) is intentionally
 *    untouched; see world/water.ts's underside/Snell's-window branch for how the sky is actually
 *    depicted from underwater instead of through this path.
 */
import * as THREE from 'three';
import { EXTINCTION, INSCATTER_COLOR, AMBIENT_HALF_DEPTH, SURFACE_BAND } from './depth-bands.js';

let installed = false;

export function installUnderwaterFog(): void {
  if (installed) return;
  installed = true;

  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  // --- Keys Run underwater extinction override — apps/client/src/world/underwater/fog-override.ts ---
  // "cameraDepth": how far below sea level (y=0) the camera itself is, >=0, zero above water.
  float uwCameraDepth = max(0.0, -cameraPosition.y);
  // "distToCamera": three's own existing camera-to-fragment fog distance (view-space -z).
  float uwDist = vFogDepth;
  // Cross-fade the two models over a small band straddling the surface, purely a function of the
  // camera's own position — see this file's header for why that is deliberate.
  float uwUnderwaterT = 1.0 - smoothstep(${(-SURFACE_BAND).toFixed(4)}, ${SURFACE_BAND.toFixed(4)}, cameraPosition.y);

  #ifdef FOG_EXP2
    float uwAboveFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float uwAboveFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  vec3 uwAboveColor = mix( gl_FragColor.rgb, fogColor, uwAboveFactor );

  if (uwUnderwaterT > 0.0005) {
    const vec3 uwK = vec3(${EXTINCTION.r.toFixed(4)}, ${EXTINCTION.g.toFixed(4)}, ${EXTINCTION.b.toFixed(4)});
    vec3 uwTransmit = exp( -uwK * (uwDist + uwCameraDepth) );
    const vec3 uwInscatter = vec3(${INSCATTER_COLOR.r.toFixed(4)}, ${INSCATTER_COLOR.g.toFixed(4)}, ${INSCATTER_COLOR.b.toFixed(4)});
    // Depth-band ambient falloff (ARCHITECTURE.md: "<10% below 20 m") — the water's own inscatter
    // veil dims with the camera's depth too, so band 5 doesn't read as a brightly-lit blue soup.
    float uwAmbientK = exp( -uwCameraDepth / ${AMBIENT_HALF_DEPTH.toFixed(3)} );
    vec3 uwBelowColor = gl_FragColor.rgb * uwTransmit + uwInscatter * uwAmbientK * (1.0 - uwTransmit);
    gl_FragColor.rgb = mix( uwAboveColor, uwBelowColor, uwUnderwaterT );
  } else {
    gl_FragColor.rgb = uwAboveColor;
  }
#endif
`;
}
