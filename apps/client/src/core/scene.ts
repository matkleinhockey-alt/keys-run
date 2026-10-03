/**
 * Renderer, scene, sky dome and lighting.
 *
 * Originally ported faithfully from legacy/index.html:577-608 as a vertex-painted sky sphere
 * repainted per time-of-day. Replaced with a fragment-shader sky dome (docs/ARCHITECTURE.md Part 2
 * item 4, "Sky + atmosphere") for a banding-free gradient, a horizon haze band (cheap aerial
 * perspective) and a proper glowing sun disc baked into the dome itself — all driven by the same
 * `SkyPalette` time-of-day.ts already produces, so `paintSky`'s signature (and every call site)
 * is unchanged; only its insides moved from a per-vertex CPU loop to four uniform writes.
 *
 * Shadow-casting: the single `sun` DirectionalLight here is no longer added to the scene — it's
 * kept purely as the colour/intensity "the sun" that time-of-day.ts mutates every frame, and
 * `core/shadows.ts`'s cascaded shadow lights read it (see `CascadedShadows.setLight`). Only the
 * CSM lights actually cast light/shadow now; see docs/ARCHITECTURE.md Part 2 item 5.
 */
import * as THREE from 'three';

export const isTouch = (): boolean =>
  typeof window !== 'undefined' && (window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window);

export interface SceneCtx {
  wrap: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  sunDir: THREE.Vector3;
  sky: THREE.Mesh;
  sunDisc: THREE.Mesh;
  /** Colour/intensity data holder for "the sun" — intentionally NOT added to the scene; see header. */
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  paintSky: (p: SkyPalette) => void;
}

export interface SkyPalette {
  top: THREE.Color; mid: THREE.Color; hor: THREE.Color; warm: THREE.Color;
  glowPow: number; glowK: number;
}

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Smooth 3-stop vertical gradient (replaces the old per-vertex lerp, now continuous instead of
// limited by the sphere's 40x20 tessellation) + a horizon haze band (cheap aerial-perspective
// stand-in: real haze is also handled by scene.fog, matched in colour — see time-of-day.ts) + a
// glow lobe around the sun direction with a tight bright core so bloom (core/postfx.ts) has
// something to catch without needing a separate billboard.
const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uHor; uniform vec3 uWarm;
uniform vec3 uSunDir; uniform float uGlowPow; uniform float uGlowK;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float t = clamp(d.y, 0.0, 1.0);
  vec3 col = t < 0.3
    ? mix(uHor, uMid, pow(t / 0.3, 0.8))
    : mix(uMid, uTop, pow((t - 0.3) / 0.7, 0.7));
  // Horizon haze: thicken the atmosphere right at eye level, independent of the gradient above.
  float haze = exp(-abs(d.y) * 9.0) * 0.5;
  col = mix(col, uHor, haze);
  float sunCos = max(dot(d, normalize(uSunDir)), 0.0);
  col += uWarm * pow(sunCos, uGlowPow) * uGlowK * (1.0 - t * 0.6);
  col += uWarm * pow(sunCos, 2200.0) * 7.0; // crisp HDR core — tonemap + bloom pick this up
  gl_FragColor = vec4(col, 1.0);
}`;

function makeSky(sunDir: THREE.Vector3): { mesh: THREE.Mesh; paintSky: (p: SkyPalette) => void } {
  const geo = new THREE.SphereGeometry(6000, 24, 16);
  const uniforms = {
    uTop: { value: new THREE.Color(0x2a76c2) },
    uMid: { value: new THREE.Color(0x7fb0d8) },
    uHor: { value: new THREE.Color(0xc9e4ee) },
    uWarm: { value: new THREE.Color(0xffd7a0) },
    uSunDir: { value: sunDir },
    uGlowPow: { value: 6 },
    uGlowK: { value: 0.55 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT,
    side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  const paintSky = (p: SkyPalette): void => {
    uniforms.uTop.value.copy(p.top);
    uniforms.uMid.value.copy(p.mid);
    uniforms.uHor.value.copy(p.hor);
    uniforms.uWarm.value.copy(p.warm);
    uniforms.uGlowPow.value = p.glowPow;
    uniforms.uGlowK.value = p.glowK;
  };
  return { mesh, paintSky };
}

export function createScene(wrap: HTMLElement): SceneCtx {
  const touch = isTouch();
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, touch ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  // r186 removed PCFSoftShadowMap (it silently downgraded to PCFShadowMap with a console warning);
  // VSMShadowMap is the modern equivalent for soft, blurrable shadows and is what the cascaded
  // shadow setup (core/shadows.ts) and quality tiers (core/quality.ts) tune per-tier.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // r186's colour-management migration: outputColorSpace already defaults to SRGBColorSpace, but
  // set it explicitly since the whole lighting re-tune below is built around it. ACESFilmicToneMapping
  // + a tuned exposure is what brings contrast back after the sRGB round-trip makes everything read
  // flatter/washed out than the old (pre-color-managed) r128 pipeline — see docs/ARCHITECTURE.md's
  // "Art direction" and this project's report for the full before/after.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.domElement.className = 'gl';
  wrap.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  const FOG = new THREE.Color(0xc9e4ee);
  scene.fog = new THREE.Fog(FOG, 260, 1750);
  const camera = new THREE.PerspectiveCamera(58, 1, 0.5, 9000);
  const sunDir = new THREE.Vector3(0.55, 0.32, -0.62).normalize();

  const { mesh: sky, paintSky } = makeSky(sunDir);
  scene.add(sky);
  // A small bright disc kept at the sun's position for a crisp specular-like core at grazing
  // angles (the dome's HDR core reads best looking straight at it; this catches the rest).
  const sunDisc = new THREE.Mesh(
    new THREE.CircleGeometry(150, 32),
    new THREE.MeshBasicMaterial({ color: 0xfff3cf, fog: false, toneMapped: false }),
  );
  scene.add(sunDisc);

  const hemi = new THREE.HemisphereLight(0xd6efff, 0x2b7088, 0.7);
  scene.add(hemi);
  // Not added to `scene` — see header. time-of-day.ts mutates its color/intensity; core/shadows.ts
  // copies those onto the real (CSM) shadow-casting lights each frame.
  const sun = new THREE.DirectionalLight(0xfff0d6, 1.05);

  return { wrap, renderer, scene, camera, sunDir, sky, sunDisc, sun, hemi, paintSky };
}
