/**
 * Shared machinery behind both catch cards (game/catch/portrait.ts's surface studio portrait and
 * underwater-trophy.ts's dive-caught grip-and-grin): rendering a small three.js scene into an
 * offscreen `WebGLRenderTarget` with the game's own `THREE.WebGLRenderer`, then blitting it into
 * a plain 2D `<canvas>` via `readRenderTargetPixels` — never a second `THREE.WebGLRenderer`/second
 * canvas (a second WebGL context has knocked out the main one on some devices and turned the
 * screen black; see portrait.ts's header for the full history).
 *
 * Extracted verbatim from portrait.ts's second iteration (the realism pass) rather than
 * rewritten — this is pure plumbing, not a place for underwater-trophy.ts to "simplify" anything,
 * per that file's own warning. The two things every such offscreen render needs:
 *
 * 1. The colour pipeline. three.js's `WebGLRenderer` only honours `toneMapping`/
 *    `outputColorSpace` when `currentRenderTarget === null` (rendering straight to the canvas);
 *    for any other render target it unconditionally renders with `NoToneMapping` and the linear
 *    `ColorManagement.workingColorSpace` regardless of the renderer's public properties. So the
 *    bytes `readRenderTargetPixels` hands back are raw linear light values with no gamma curve —
 *    `readback` below does the CPU fix once the pixels are already in hand for the row-flip: ports
 *    three's own ACES filmic curve (`tonemapping_pars_fragment`'s coefficients) plus the live
 *    `renderer.toneMappingExposure`, then encodes to sRGB through a precomputed LUT.
 *
 * 2. An environment map. A wet fish/wetsuit's realism is almost entirely specular/fresnel —
 *    `MeshStandardMaterial`/`MeshPhysicalMaterial` need something in `scene.environment` to
 *    reflect. `buildGradientEnv` builds a small procedural sky/water-gradient + accent-light PMREM
 *    once per distinct look (callers cache the returned texture at module scope — a surface-lit
 *    look and an underwater-tinted look are different textures, not the same cached one).
 */
import * as THREE from 'three';

// ---- colour pipeline -------------------------------------------------------------------------

const SRGB_LUT_N = 1024;
const SRGB_LUT = new Uint8ClampedArray(SRGB_LUT_N + 1);
for (let i = 0; i <= SRGB_LUT_N; i++) {
  const v = i / SRGB_LUT_N;
  SRGB_LUT[i] = Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
}
function encodeSRGB(v: number): number {
  if (v <= 0) return SRGB_LUT[0];
  if (v >= 1) return SRGB_LUT[SRGB_LUT_N];
  return SRGB_LUT[(v * SRGB_LUT_N + 0.5) | 0];
}

/** Three.js's `ACESFilmicToneMapping` GLSL, ported to run once per pixel on the CPU — same
 * `RRTAndODTFit` + input/output matrices, same `exposure / 0.6` scale. */
function toLDR(r: number, g: number, b: number, exposure: number, out: Float64Array): void {
  const s = exposure / 0.6;
  r *= s; g *= s; b *= s;
  const ar = 0.59719 * r + 0.35458 * g + 0.04823 * b;
  const ag = 0.07600 * r + 0.90834 * g + 0.01566 * b;
  const ab = 0.02840 * r + 0.13383 * g + 0.83777 * b;
  const fr = (ar * (ar + 0.0245786) - 0.000090537) / (ar * (0.983729 * ar + 0.4329510) + 0.238081);
  const fg = (ag * (ag + 0.0245786) - 0.000090537) / (ag * (0.983729 * ag + 0.4329510) + 0.238081);
  const fb = (ab * (ab + 0.0245786) - 0.000090537) / (ab * (0.983729 * ab + 0.4329510) + 0.238081);
  let or_ = 1.60475 * fr - 0.53108 * fg - 0.07367 * fb;
  let og = -0.10208 * fr + 1.10813 * fg - 0.00605 * fb;
  let ob = -0.00327 * fr - 0.07276 * fg + 1.07602 * fb;
  if (or_ < 0) or_ = 0; else if (or_ > 1) or_ = 1;
  if (og < 0) og = 0; else if (og > 1) og = 1;
  if (ob < 0) ob = 0; else if (ob > 1) ob = 1;
  out[0] = or_; out[1] = og; out[2] = ob;
}

export interface OffscreenRig {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  rt: THREE.WebGLRenderTarget;
  w: number;
  h: number;
  ctx2d: CanvasRenderingContext2D;
  img: ImageData;
  buf: Uint8Array;
}

/** Builds the render-target + 2D-canvas plumbing a `show()`/`render()` pair needs — everything
 * that was duplicated boilerplate between a surface and an underwater rig. Callers still own
 * their own `scene`/`camera` (lighting/background/subject differ on purpose) and pass them in. */
/**
 * Sizes a portrait canvas's backing store to the display it is actually on.
 *
 * The markup declares `width="640" height="300"`, but CSS lays the element out at
 * `min(360px, 80vw)` (style.css) — so on any 2x display the browser is asked for ~720 device
 * pixels across and given 640, and upsamples. That is the soft, slightly smeared look on a retina
 * screen, and no amount of lighting or material work fixes it.
 *
 * The declared attributes still set the aspect ratio (and the CSS `aspect-ratio` matches them),
 * so only the pixel count changes here, never the framing.
 *
 * Capped by total pixels because `readback` below tonemaps and sRGB-encodes every pixel on the
 * CPU: the cost is linear in area, and this runs per portrait frame. The cap is chosen to land
 * just above a 2x 360 px-wide card (~243k px) and to refuse to chase a 3x display all the way to
 * half a megapixel for a thumbnail.
 */
const MAX_PORTRAIT_PX = 260_000;

/** The portrait's declared backing size, and the aspect every rig frames to. Constants rather
 * than reads of `cv.width`/`cv.height`, because this function *mutates* those attributes —
 * deriving the aspect from them would feed each call's rounding into the next. Must stay in sync
 * with index.html's `#fishCanvas` and style.css's matching `aspect-ratio`. */
const DECLARED_W = 640;
const DECLARED_H = 300;

export function sizeCanvasForDisplay(cv: HTMLCanvasElement): { w: number; h: number } {
  const aspect = DECLARED_W / DECLARED_H;
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 3);
  // clientWidth is 0 while the card is display:none — fall back to the declared width so a
  // portrait built before the card is first shown is not sized to nothing.
  const cssW = cv.clientWidth || 0;
  // Never go *below* the declared attribute size. On a 1x display the CSS box (~360 px) is
  // narrower than the 640 px backing store the markup asks for, so sizing purely from
  // clientWidth*dpr would quietly halve the resolution — a downgrade on exactly the machines
  // with the least headroom to spare. This only ever adds pixels.
  let w = Math.max(DECLARED_W, Math.round(cssW * dpr));
  let h = Math.max(1, Math.round(w / aspect));
  if (w * h > MAX_PORTRAIT_PX) {
    const k = Math.sqrt(MAX_PORTRAIT_PX / (w * h));
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
  }
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return { w, h };
}

export function buildOffscreenRig(canvasId: string, scene: THREE.Scene, camera: THREE.PerspectiveCamera): OffscreenRig | null {
  const cv = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!cv) return null;
  const { w, h } = sizeCanvasForDisplay(cv);
  const rt = new THREE.WebGLRenderTarget(w, h);
  // Not sRGB: this target never gets three's automatic output-colourspace treatment regardless of
  // what we tag it (see this file's header) — tagging it accurately as linear documents that
  // `readback` below does the sRGB encode itself on readback, rather than implying the bytes
  // already are sRGB.
  rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
  const ctx2d = cv.getContext('2d');
  if (!ctx2d) return null;
  return { scene, camera, rt, w, h, ctx2d, img: ctx2d.createImageData(w, h), buf: new Uint8Array(w * h * 4) };
}

/** Renders `rig.scene`/`rig.camera` into `rig.rt` with the game's own renderer, reads it back,
 * and blits the tonemapped+sRGB-encoded result into `rig.ctx2d` — the exact sequence portrait.ts's
 * original `render()` ran. `alpha(x,y)` lets a caller make part of the frame transparent in the
 * destination canvas (portrait's background is always opaque; underwater-trophy's backdrop is
 * too, so both pass `undefined` today, but the hook costs nothing to keep). */
/**
 * Re-sizes an existing rig if the canvas's display size has changed since it was built, and
 * returns true when it did.
 *
 * Needed because the catch card is `display:none` until the first catch, so `clientWidth` is 0
 * when the rig is first constructed and `sizeCanvasForDisplay` has to fall back to the declared
 * attribute width. The first `show()` after the card becomes visible is where the real size
 * finally exists — without this the portrait would stay stuck at the fallback resolution for the
 * whole session. Also covers a window moving between a 1x and a 2x display.
 */
export function resyncRigSize(rig: OffscreenRig, canvasId: string): boolean {
  const cv = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!cv) return false;
  const prevW = cv.width, prevH = cv.height;
  const { w, h } = sizeCanvasForDisplay(cv);
  if (w === rig.w && h === rig.h && w === prevW && h === prevH) return false;
  rig.rt.dispose();
  rig.rt = new THREE.WebGLRenderTarget(w, h);
  rig.rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
  rig.w = w; rig.h = h;
  rig.img = rig.ctx2d.createImageData(w, h);
  rig.buf = new Uint8Array(w * h * 4);
  return true;
}

export function readback(renderer: THREE.WebGLRenderer, rig: OffscreenRig): void {
  const prevCol = renderer.getClearColor(new THREE.Color()), prevA = renderer.getClearAlpha();
  const prevT = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevSh = renderer.shadowMap.enabled;
  const exposure = renderer.toneMappingExposure; // read live — matches core/scene.ts without duplicating its value
  renderer.setRenderTarget(rig.rt);
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = true;
  renderer.clear();
  renderer.render(rig.scene, rig.camera);
  renderer.readRenderTargetPixels(rig.rt, 0, 0, rig.w, rig.h, rig.buf);
  renderer.setRenderTarget(prevT);
  renderer.setClearColor(prevCol, prevA);
  renderer.autoClear = prevAuto;
  renderer.shadowMap.enabled = prevSh;

  const { w: W, h: H, buf: src } = rig;
  const dst = rig.img.data;
  const ldr = new Float64Array(3);
  const inv255 = 1 / 255;
  // Flip rows (GL reads bottom-up) and, per pixel, run the ACES filmic curve + sRGB gamma three's
  // own output pipeline would have applied for a canvas-target render (see this file's header).
  for (let y = 0; y < H; y++) {
    const srcRow = (H - 1 - y) * W * 4, dstRow = y * W * 4;
    for (let x = 0; x < W; x++) {
      const si = srcRow + x * 4, di = dstRow + x * 4;
      toLDR(src[si] * inv255, src[si + 1] * inv255, src[si + 2] * inv255, exposure, ldr);
      dst[di] = encodeSRGB(ldr[0]);
      dst[di + 1] = encodeSRGB(ldr[1]);
      dst[di + 2] = encodeSRGB(ldr[2]);
      dst[di + 3] = 255;
    }
  }
  rig.ctx2d.putImageData(rig.img, 0, 0);
}

// ---- environment ------------------------------------------------------------------------------

export interface GradientEnvSpec {
  /** Sky-sphere gradient, sampled by world-Y (-1..1 over the sphere). */
  top: number;
  horizon: number;
  deep: number;
  /** A bright accent the PMREM convolution turns into a soft specular highlight. */
  accent: { color: number; intensity: number; pos: [number, number, number]; radius: number };
  /** A cooler bounce patch opposite the accent, so one flank doesn't go flat. */
  bounce: { color: number; intensity: number; pos: [number, number, number]; radius: number };
}

/** Builds a small procedural sky/water-gradient + two accent lights into a PMREM env texture —
 * portrait.ts's `ensureEnv`, parametrized so underwater-trophy.ts can ask for a darker,
 * blue-green-shifted look instead of the surface card's bright sky without duplicating the PMREM
 * boilerplate. Callers cache the result themselves (module-scope `let cached: Texture | null`) —
 * this always builds fresh, since "once per distinct look" is a caller-level cardinality this
 * function has no way to know. */
export function buildGradientEnv(renderer: THREE.WebGLRenderer, spec: GradientEnvSpec): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();

  const skyGeo = new THREE.SphereGeometry(40, 20, 14);
  const posAttr = skyGeo.attributes.position;
  const colors = new Float32Array(posAttr.count * 3);
  const top = new THREE.Color(spec.top), horizon = new THREE.Color(spec.horizon), deep = new THREE.Color(spec.deep);
  const c = new THREE.Color();
  for (let i = 0; i < posAttr.count; i++) {
    const t = THREE.MathUtils.clamp(posAttr.getY(i) / 40, -1, 1);
    if (t >= 0) c.copy(horizon).lerp(top, t); else c.copy(horizon).lerp(deep, -t);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  skyGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const skyMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, toneMapped: false });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  envScene.add(sky);

  const accentMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(spec.accent.color).multiplyScalar(spec.accent.intensity), toneMapped: false });
  const accent = new THREE.Mesh(new THREE.SphereGeometry(spec.accent.radius, 12, 8), accentMat);
  accent.position.set(...spec.accent.pos);
  envScene.add(accent);
  const bounceMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(spec.bounce.color).multiplyScalar(spec.bounce.intensity), toneMapped: false });
  const bounce = new THREE.Mesh(new THREE.SphereGeometry(spec.bounce.radius, 12, 8), bounceMat);
  bounce.position.set(...spec.bounce.pos);
  envScene.add(bounce);

  const rt = pmrem.fromScene(envScene, 0.035, 0.1, 100, { size: 128 });
  pmrem.dispose();
  skyGeo.dispose(); skyMat.dispose();
  accent.geometry.dispose(); accentMat.dispose();
  bounce.geometry.dispose(); bounceMat.dispose();

  return rt.texture;
}
