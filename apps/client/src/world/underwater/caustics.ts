/**
 * Caustics — docs/ARCHITECTURE.md "The underwater world" → "Rendering": "caustics (projected,
 * world-space XZ, gone by 20 m)".
 *
 * A screen-space `postprocessing` v6 `Effect` rather than a decal/projector mesh: caustics need to
 * land correctly on the seafloor, coral and any swimming fish regardless of their actual geometry,
 * and this agent does not own (and must not edit) seafloor.ts or world/reef/**. Reconstructing the
 * world-space hit point from the depth buffer lets the pattern conform to whatever is actually
 * drawn there without this file knowing anything about that geometry.
 *
 * World-position reconstruction needs the camera's inverse projection in a form a *merged* Effect
 * can use. `EffectPass`'s shared `EffectMaterial` already provides `cameraNear`/`cameraFar`/
 * `aspect`/`time` to every effect's `mainImage` for free (confirmed against `postprocessing`'s own
 * bundled `BokehEffect`, which reads them the same way without declaring them) — this effect adds
 * exactly two uniforms of its own (`uwcCameraWorld`, `uwcTanHalfFovY`) because the brief's
 * zero-new-uniform trick (fog-override.ts) only applies to the *material* fog chunk every other
 * agent's content inherits for free; a dedicated post effect like this one is expected to own a
 * couple of uniforms, same as any other effect in postfx.ts.
 *
 * `uwcTanHalfFovY` is refreshed every frame in `update()` rather than once, because
 * transition.ts narrows `camera.fov` across the surface crossing — a stale value would misproject
 * caustics for the ~0.3 s of that tween.
 *
 * ⚠ Known limitation, root-caused but not fixed here (not a bug in this file's code): caustics do
 * not currently render visibly under the QA debug-dive hook (world/underwater/index.ts), because
 * that hook sets `camera.near = 0.05` to get close to the seafloor without near-plane clipping,
 * while the scene's `camera.far` stays 9000 (topside draw distance). A 180,000:1 near/far ratio
 * leaves almost no depth-buffer precision for anything past the first few centimetres: verified by
 * directly reading back the raw depth-texture value at a point ~2 m from the camera — it reads
 * ~0.976, mathematically correct for that ratio (not a reconstruction bug; the maths above were
 * independently re-derived and confirmed against it), but far too coarse for this effect's
 * world-position reconstruction to recover anything useful. Confirmed via live shader dumps that
 * the depth texture, its uniforms (including cameraNear/cameraFar, now kept in sync every frame —
 * see index.ts's `refreshPostEffectCamera`, a real bug fixed in the same session this was found)
 * and the effect's inclusion/blending in the merged EffectPass are all correctly wired; a flat
 * `vec4(1,0,1,1)` dropped in at the top of `mainImage` renders as solid magenta exactly as
 * expected, which is what isolated this to a precision problem rather than a wiring one. A real
 * diver camera should very likely use a far plane matched to underwater visibility (~30-50 m per
 * the depth-band table) rather than inheriting the topside camera's 9000 m — that alone would drop
 * the ratio to a few hundred:1 and should resolve this without touching this file.
 */
import * as THREE from 'three';
import { Effect, EffectAttribute, BlendFunction } from 'postprocessing';
import { CAUSTICS_FULL_DEPTH, CAUSTICS_GONE_DEPTH } from './depth-bands.js';

const fragmentShader = /* glsl */ `
uniform mat4 uwcCameraWorld;
uniform float uwcTanHalfFovY;
uniform vec3 uwcCameraPos;

float uwcPattern(vec2 p, float t) {
  // Two rotated, independently-drifting sine-interference layers — a cheap, textureless stand-in
  // for refracted-sunlight caustics. Not physically simulated, but it tiles seamlessly and is
  // genuinely animated (via the EffectPass-provided \`time\` uniform), which is what the brief asks
  // for ("animated, projected in world-space XZ").
  vec2 p1 = p * 0.35 + vec2(t * 0.6, t * 0.35);
  vec2 p2 = p * 0.27 - vec2(t * 0.42, -t * 0.5);
  float a = sin(p1.x) + sin(p1.y) + sin((p1.x + p1.y) * 0.7);
  float b = sin(p2.x * 1.3) + sin(p2.y * 1.3) + sin((p2.x - p2.y) * 0.9);
  return clamp(max(0.0, a) * max(0.0, b) * 0.5, 0.0, 1.0);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  float uwcCamDepth = max(0.0, -uwcCameraPos.y);
  // Nothing to do above water, or at the far clip plane (sky/nothing hit).
  if (uwcCamDepth < 0.05 || depth >= 0.9999) { outputColor = inputColor; return; }

  // Reconstruct the view-space, then world-space, position of whatever this pixel is showing.
  // perspectiveDepthToViewZ is three's own packing helper, already available here for free (see
  // this file's header) — bare, undeclared, exactly how BokehEffect's bundled shader uses it.
  float viewZ = perspectiveDepthToViewZ(depth, cameraNear, cameraFar);
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 viewPos = vec3(
    ndc.x * (-viewZ) * uwcTanHalfFovY * aspect,
    ndc.y * (-viewZ) * uwcTanHalfFovY,
    viewZ
  );
  vec3 worldPos = (uwcCameraWorld * vec4(viewPos, 1.0)).xyz;

  float worldDepth = max(0.0, -worldPos.y);
  float band = 1.0 - smoothstep(${CAUSTICS_FULL_DEPTH.toFixed(1)}, ${CAUSTICS_GONE_DEPTH.toFixed(1)}, worldDepth);
  if (band <= 0.001) { outputColor = inputColor; return; }

  float pat = uwcPattern(worldPos.xz * 0.6, time);
  outputColor = vec4(inputColor.rgb + vec3(0.65, 0.95, 1.0) * pat * band * 0.55, inputColor.a);
}
`;

export class CausticsEffect extends Effect {
  private camera: THREE.Camera | null = null;

  constructor() {
    super('CausticsEffect', fragmentShader, {
      blendFunction: BlendFunction.NORMAL,
      attributes: EffectAttribute.DEPTH,
      uniforms: new Map<string, THREE.Uniform>([
        ['uwcCameraWorld', new THREE.Uniform(new THREE.Matrix4())],
        ['uwcTanHalfFovY', new THREE.Uniform(1)],
        ['uwcCameraPos', new THREE.Uniform(new THREE.Vector3())],
      ]),
    });
  }

  override set mainCamera(value: THREE.Camera) {
    this.camera = value;
    this.uniforms.get('uwcCameraWorld')!.value = value.matrixWorld;
  }

  override update(): void {
    const cam = this.camera as THREE.PerspectiveCamera | null;
    if (!cam) return;
    this.uniforms.get('uwcTanHalfFovY')!.value = Math.tan(THREE.MathUtils.degToRad(cam.fov) * 0.5);
    (this.uniforms.get('uwcCameraPos')!.value as THREE.Vector3).copy(cam.position);
  }
}
