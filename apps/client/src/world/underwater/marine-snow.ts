/**
 * Marine snow — docs/ARCHITECTURE.md "The underwater world" → "Rendering". GPU points, density
 * rising with depth, following the pool/`THREE.Points` pattern already established in
 * `world/particles.ts` (read, not duplicated: that pool is wake/spray-shaped — gravity, a finite
 * lifetime, a `splash()` burst API — none of which marine snow needs, and it is the boat/wake
 * agent's file to extend, not this one's).
 *
 * Particles live in a box centred on the camera and wrap around it on all three axes as it moves
 * (`wrap`, below) rather than being spawned/despawned — the standard "infinite attached volume"
 * technique for rain/snow-type effects, and it means a fixed, small pool with no per-frame
 * allocation or recycling logic. Depth-dependent density is achieved by scaling *opacity* with
 * depth rather than activating/deactivating individual particles, which keeps the per-frame update
 * a flat, branch-free loop over a fixed-size typed array.
 *
 * ⚠ r186 colour-management note (docs/ARCHITECTURE.md's "known landmine", also hit once already
 * by world/particles.ts's wake foam): overlapping transparent sprites blend in correct linear
 * light here, so they saturate to flat white far sooner than they did under r128. Kept dim
 * (max ~0.35 alpha) and small on purpose — real marine snow is barely-visible floating detritus,
 * not bright confetti, so this cuts the saturation risk and the look right at the same time.
 */
import * as THREE from 'three';
import { waterNoiseTex } from '../../core/textures.js';
import { MARINE_SNOW_MAX } from './depth-bands.js';

const BOX = 11; // metres — half-extent of the camera-centred volume particles wrap within

export interface MarineSnow {
  points: THREE.Points;
  /** `depthFraction` is clamp01(cameraDepth / MARINE_SNOW_FULL_DEPTH) * underwaterAmount — index.ts
   * computes it since it already knows both numbers; this module just renders the result. */
  update(dt: number, cameraPos: THREE.Vector3, depthFraction: number): void;
  dispose(): void;
}

export function createMarineSnow(pixelRatio = 1): MarineSnow {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(MARINE_SNOW_MAX * 3);
  const vel = new Float32Array(MARINE_SNOW_MAX * 3);
  const seed = new Float32Array(MARINE_SNOW_MAX);
  for (let i = 0; i < MARINE_SNOW_MAX; i++) {
    pos[i * 3] = (Math.random() * 2 - 1) * BOX;
    pos[i * 3 + 1] = (Math.random() * 2 - 1) * BOX;
    pos[i * 3 + 2] = (Math.random() * 2 - 1) * BOX;
    vel[i * 3] = (Math.random() - 0.5) * 0.035;
    vel[i * 3 + 1] = -0.05 - Math.random() * 0.09; // slow, steady sink
    vel[i * 3 + 2] = (Math.random() - 0.5) * 0.035;
    seed[i] = Math.random();
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('pseed', new THREE.BufferAttribute(seed, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), BOX * 1.8);

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: false, // this *is* an underwater-only effect; fog-override.ts's extinction would double up
    uniforms: {
      uPR: { value: pixelRatio },
      uDensity: { value: 0 },
      uNoise: { value: waterNoiseTex() },
      uTime: { value: 0 },
    },
    vertexShader: `
      attribute float pseed;
      uniform float uPR;
      uniform float uTime;
      varying float vSeed;
      varying float vFade;
      void main() {
        vSeed = pseed;
        // Gentle per-particle wobble layered on top of the JS-driven sink/drift (see update()),
        // cheap and GPU-side so it costs nothing extra on the JS loop.
        vec3 p = position;
        p.x += sin(uTime * 0.6 + pseed * 37.0) * 0.08;
        p.z += cos(uTime * 0.5 + pseed * 53.0) * 0.08;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        // Fade near the far edge of the attached volume so wrapping never pops visibly.
        vFade = smoothstep(${BOX.toFixed(1)}, ${(BOX * 0.55).toFixed(1)}, length(p));
        gl_PointSize = (1.1 + pseed * 1.4) * uPR * (140.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform sampler2D uNoise;
      uniform float uDensity;
      varying float vSeed;
      varying float vFade;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
        float n = texture2D(uNoise, gl_PointCoord * 0.6 + vec2(vSeed, vSeed * 1.3)).a;
        float edge = smoothstep(0.5, 0.0, d);
        // Deliberately low ceiling (see this file's header) — many overlapping specks must stay a
        // soft haze under r186's linear-light blending, never a white mass.
        float a = edge * (0.12 + 0.23 * n) * uDensity * vFade;
        gl_FragColor = vec4(0.82, 0.88, 0.86, a);
      }
    `,
  });

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 2;

  let t = 0;
  function update(dt: number, cameraPos: THREE.Vector3, depthFraction: number): void {
    t += dt;
    mat.uniforms.uTime.value = t;
    mat.uniforms.uDensity.value = Math.max(0, Math.min(1, depthFraction));
    if (depthFraction <= 0) return; // nothing visible — skip the position churn entirely
    for (let i = 0; i < MARINE_SNOW_MAX; i++) {
      const o = i * 3;
      pos[o] += vel[o] * dt;
      pos[o + 1] += vel[o + 1] * dt;
      pos[o + 2] += vel[o + 2] * dt;
      // Wrap each axis back into [-BOX, BOX) *relative to the camera*, independently — the
      // "infinite attached volume" trick: subtract the camera's position, wrap into the box, add
      // it back, so particles only ever appear to drift within BOX of wherever the camera now is.
      // A true centred modulo (not a single conditional +/-2*BOX) so this is also correct on the
      // very first frame, when particles were seeded near world-origin and the camera may already
      // be thousands of metres away.
      const span = BOX * 2;
      for (let axis = 0; axis < 3; axis++) {
        const camC = axis === 0 ? cameraPos.x : axis === 1 ? cameraPos.y : cameraPos.z;
        const rel = pos[o + axis] - camC;
        const wrapped = (((rel + BOX) % span) + span) % span - BOX;
        pos[o + axis] = camC + wrapped;
      }
    }
    geo.attributes.position.needsUpdate = true;
  }

  return {
    points,
    update,
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
