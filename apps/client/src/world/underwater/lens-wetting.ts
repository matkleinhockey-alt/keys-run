/**
 * Lens-wetting — one of the three things that sell the surface crossing (docs/ARCHITECTURE.md:
 * "the ~200 ms crossing y=0 is the most important moment in the game: ... a lens-wetting screen
 * effect"). A screen-space `postprocessing` v6 `Effect`: a few procedural droplet/smear blobs that
 * flash onto the view at the moment of crossing and drain away over about a second, plus a
 * constant faint underwater vignette/softening so submerged shots don't look identical to a plain
 * tinted dry shot.
 *
 * Driven by a single uniform (`uwlWetness`, 0..1) that transition.ts owns and index.ts refreshes
 * every frame — this effect doesn't know or care *why* that number is what it is, just renders it.
 */
import * as THREE from 'three';
import { Effect, BlendFunction } from 'postprocessing';

const fragmentShader = /* glsl */ `
uniform float uwlWetness;      // transient pulse, ~1 right at the crossing, decaying over ~1s
uniform float uwlUnderwater;   // steady 0..1, the same blend transition.ts/fog-override.ts use

float uwlHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }

// A handful of fixed, randomly-placed "droplets" — cheap screen-space blobs with a bright rim and
// a refractive-looking dark core, classic water-on-a-lens look.
float uwlDroplets(vec2 uv, float aspectR) {
  float acc = 0.0;
  for (int i = 0; i < 9; i++) {
    vec2 seed = vec2(float(i) * 12.9898, float(i) * 78.233);
    vec2 center = vec2(uwlHash(seed), uwlHash(seed + 7.0));
    float r = 0.012 + 0.03 * uwlHash(seed + 13.0);
    vec2 d = (uv - center) * vec2(aspectR, 1.0);
    float dist = length(d) / r;
    float drop = smoothstep(1.0, 0.75, dist) * (1.0 - smoothstep(0.0, 0.55, dist) * 0.6);
    acc = max(acc, drop);
  }
  return acc;
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 col = inputColor.rgb;
  if (uwlUnderwater > 0.001) {
    // Faint constant softening/vignette while submerged (mask behind a dive mask / water film).
    float vig = smoothstep(0.35, 0.95, length(uv - 0.5));
    col = mix(col, col * 0.9, vig * uwlUnderwater * 0.5);
  }
  if (uwlWetness > 0.003) {
    float drops = uwlDroplets(uv, resolution.x / max(resolution.y, 1.0));
    col += vec3(0.75, 0.85, 0.9) * drops * uwlWetness * 0.5;
    col = mix(col, col * (1.0 - 0.25 * drops), uwlWetness);
  }
  outputColor = vec4(col, inputColor.a);
}
`;

export class LensWettingEffect extends Effect {
  constructor() {
    super('LensWettingEffect', fragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['uwlWetness', new THREE.Uniform(0)],
        ['uwlUnderwater', new THREE.Uniform(0)],
      ]),
    });
  }

  setAmounts(wetness: number, underwater: number): void {
    this.uniforms.get('uwlWetness')!.value = wetness;
    this.uniforms.get('uwlUnderwater')!.value = underwater;
  }
}
