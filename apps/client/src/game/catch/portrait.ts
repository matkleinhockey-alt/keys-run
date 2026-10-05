/**
 * The catch-card "studio portrait": a slowly turning fish rendered with the game's own
 * `THREE.WebGLRenderer` into an offscreen `WebGLRenderTarget`, then blitted into a plain 2D
 * `<canvas>` via `readRenderTargetPixels`.
 *
 * ⚠ Preserve this approach exactly (legacy index.html:2876-2877's comment, carried forward
 * verbatim below) — do not "simplify" this into a second `THREE.WebGLRenderer`/second canvas.
 *
 * > a studio portrait of the catch in the card. It's drawn with the game's own renderer into an
 * > offscreen target and copied into a plain 2D canvas — a second WebGL context could knock out
 * > the main one on some devices and turn the screen black.
 *
 * Renders a generic `makeFishMesh` body rather than legacy's detailed per-species `VGEO` — see
 * fish-mesh.ts's header for why (entities/fish/** hadn't landed on `integration` yet).
 *
 * ## Realism pass (this file's second iteration)
 *
 * Three things made the original render read as a plastic toy rather than a photo, in order of
 * how much they mattered:
 *
 * 1. No environment map. A wet fish's realism is almost entirely specular/fresnel — with no
 *    `scene.environment`, `MeshStandardMaterial`'s reflections had nothing to reflect. `ensureEnv`
 *    below builds a tiny procedural sky/water gradient + "sun" PMREM once (cached at module scope,
 *    first catch of the session pays for it, every catch after is free) and the portrait scene
 *    uses it for IBL.
 *
 * 2. The colour pipeline was silently wrong. The main renderer runs ACES tone mapping (actually
 *    owned by `core/postfx.ts`'s composer, not `renderer.toneMapping` — see that file's header)
 *    and sRGB output. It is tempting to flip `renderer.toneMapping`/`renderer.outputColorSpace`
 *    to match before rendering the portrait and flip them back after — **that does nothing**:
 *    three.js's `WebGLRenderer` only honours `toneMapping`/`outputColorSpace` when
 *    `currentRenderTarget === null` (i.e. rendering straight to the canvas); for any other render
 *    target — ours included — it unconditionally renders with `NoToneMapping` and the *linear*
 *    `ColorManagement.workingColorSpace`, regardless of what the renderer's public properties say
 *    (see `WebGLRenderer`'s `currentRenderTarget === null ? renderer.outputColorSpace : ...`
 *    checks and the matching `toneMapping`/`NoToneMapping` branch in `WebGLPrograms`). So the
 *    bytes `readRenderTargetPixels` handed back were raw linear light values with no gamma curve
 *    at all — which is exactly "washed out and dark" (linear values read as if they were already
 *    sRGB-encoded look crushed/muddy, and nothing above 1.0 got the filmic highlight rolloff).
 *    The fix has to happen on the CPU, while we already have the pixels in hand for the row-flip:
 *    `toLDR` below ports three's own ACES filmic curve (same coefficients as
 *    `tonemapping_pars_fragment`) plus the live `renderer.toneMappingExposure`, then encodes to
 *    sRGB through a precomputed LUT (no per-pixel `Math.pow`, so the extra pass stays cheap).
 *
 * 3. Flat, shadowless three-point-ish lighting with no rim and no backdrop. `ensureRig` now wires
 *    a warm key / cool fill / cool rim (the rim is what actually separates the silhouette from the
 *    background — compare before/after with it alone disabled) and `scene.background` carries a
 *    deep-water gradient with a soft glow behind the subject and a touch of bottom-edge darkening
 *    standing in for a contact shadow, instead of flat black/transparent.
 *
 * `applyPortraitMaterial` swaps each mesh's shared, cached `fish-mesh.ts` material for a
 * **portrait-local clone** (`MeshPhysicalMaterial` with a little clearcoat + iridescence for the
 * wet-skin look) rather than mutating the cache in place — the cache is also used by the live
 * hooked-fish mesh, the jump animation and the grip-and-grin hang rig (`catch-flow.ts`'s
 * `setupPhoto`), none of which this task owns.
 */
import * as THREE from 'three';
import { makeFishMesh } from '../fishing/fish-mesh.js';

interface PortraitRig {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  pivot: THREE.Group;
  rt: THREE.WebGLRenderTarget;
  w: number;
  h: number;
  ctx2d: CanvasRenderingContext2D;
  img: ImageData;
  buf: Uint8Array;
  mesh: THREE.Group | null;
  last: number;
}

export interface Portrait {
  show(color: string, lenM: number, elongated?: boolean): void;
  render(renderer: THREE.WebGLRenderer, t: number): void;
  clear(): void;
}

// ---- colour pipeline (see header item 2) -----------------------------------------------------

/** Precomputed linear -> sRGB LUT so the per-pixel tonemap pass below needs no `Math.pow` — this
 * runs on every portrait frame (throttled to ~8fps by `render`, but still inside a live frame). */
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

/** Three.js's `ACESFilmicToneMapping` GLSL (tonemapping_pars_fragment), ported to run once per
 * pixel on the CPU — same `RRTAndODTFit` + input/output matrices, same `exposure / 0.6` scale. */
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

// ---- environment (see header item 1) ---------------------------------------------------------

/** Built once, lazily, the first time a portrait is ever rendered — cached for the life of the
 * page so every catch after the first one is free. A small custom sky/water gradient rather than
 * three/examples/jsm's `RoomEnvironment`: a fish held up for a photo should reflect sky and water,
 * not a grey interior, and this avoids introducing a new `three/examples/jsm` import path. */
let sharedEnv: THREE.Texture | null = null;
function ensureEnv(renderer: THREE.WebGLRenderer): THREE.Texture {
  if (sharedEnv) return sharedEnv;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();

  const skyGeo = new THREE.SphereGeometry(40, 20, 14);
  const posAttr = skyGeo.attributes.position;
  const colors = new Float32Array(posAttr.count * 3);
  const top = new THREE.Color(0xdcefec), horizon = new THREE.Color(0x1f6f73), deep = new THREE.Color(0x041824);
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

  // A bright "sun" patch gives the PMREM convolution something to turn into a soft specular
  // highlight at low roughness; a cooler bounce patch opposite it stops one flank going flat.
  const sunMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff2d9).multiplyScalar(5), toneMapped: false });
  const sun = new THREE.Mesh(new THREE.SphereGeometry(3, 12, 8), sunMat);
  sun.position.set(14, 22, -8);
  envScene.add(sun);
  const bounceMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x2f8aa8).multiplyScalar(1.6), toneMapped: false });
  const bounce = new THREE.Mesh(new THREE.SphereGeometry(5, 12, 8), bounceMat);
  bounce.position.set(-16, -4, 10);
  envScene.add(bounce);

  const rt = pmrem.fromScene(envScene, 0.035, 0.1, 100, { size: 128 });
  pmrem.dispose();
  skyGeo.dispose(); skyMat.dispose();
  sun.geometry.dispose(); sunMat.dispose();
  bounce.geometry.dispose(); bounceMat.dispose();

  sharedEnv = rt.texture;
  return sharedEnv;
}

/** A deep-water gradient backdrop (brief item 4) with a soft glow behind the subject and a
 * darker lower band standing in for a contact shadow (item 3's "or gradient beneath" — cheaper
 * and more robust across camera angles than a literal ground-shadow mesh). Set as `scene.
 * background`: three.js renders a plain `Texture` background as a full-screen quad independent
 * of camera near/far, so it always fills the frame regardless of how close/far a given fish's
 * camera sits. */
function buildBackdrop(): THREE.CanvasTexture {
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, '#0a2b3d');
  grad.addColorStop(0.42, '#1c5064');
  grad.addColorStop(1, '#071b26');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const glow = ctx.createRadialGradient(size * 0.52, size * 0.44, size * 0.04, size * 0.52, size * 0.44, size * 0.6);
  glow.addColorStop(0, 'rgba(140,224,214,0.30)');
  glow.addColorStop(1, 'rgba(140,224,214,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  const vig = ctx.createRadialGradient(size / 2, size * 0.52, size * 0.3, size / 2, size * 0.52, size * 0.76);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function disposeMesh(mesh: THREE.Group): void {
  mesh.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose()); else mat?.dispose();
  });
}

/** Replaces each child mesh's shared `fish-mesh.ts` material (flat-shaded, cached per colour —
 * also used by the live hooked-fish mesh / jump animation / hang rig) with a portrait-local
 * `MeshPhysicalMaterial` clone: smooth shading (the shared material forces `flatShading`) plus a
 * little clearcoat + iridescence for the wet-skin look (brief item 6). Never touches the cached
 * original. */
function applyPortraitMaterial(mesh: THREE.Group): void {
  mesh.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh) return;
    const src = m.material as THREE.MeshStandardMaterial;
    m.material = new THREE.MeshPhysicalMaterial({
      color: src.color.clone(),
      roughness: 0.34,
      metalness: 0.06,
      clearcoat: 0.65,
      clearcoatRoughness: 0.2,
      iridescence: 0.22,
      iridescenceIOR: 1.3,
      envMapIntensity: 1.15,
    });
  });
}

/** legacy `fishPortrait`/`renderPortrait` (index.html:2878-2906). `canvasId` is the `<canvas>`
 * inside the catch card (`#fishCanvas`). */
export function createPortrait(canvasId: string): Portrait {
  let rig: PortraitRig | null = null;

  function ensureRig(): PortraitRig | null {
    if (rig) return rig;
    const cv = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (!cv) return null;
    const W = cv.width || 640, H = cv.height || 300;
    const scene = new THREE.Scene();
    scene.background = buildBackdrop();
    // Weak ambient floor — the environment map (added lazily, first render) carries most of the
    // soft fill/specular now; this just keeps unlit backsides off pure black on the first frame
    // before that's ready.
    scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x08202c, 0.32));
    const key = new THREE.DirectionalLight(0xfff0d8, 1.25); key.position.set(3, 4, 2.2); scene.add(key);
    // Water-bounce fill from below rather than the camera side — a hand-held fish over open
    // water picks up soft cool light reflecting up off the surface more than a lateral fill.
    const fill = new THREE.DirectionalLight(0x6fc9d9, 0.4); fill.position.set(0.8, -3, 1.6); scene.add(fill);
    // Rim/kicker (brief item 3) — placed behind the subject from the camera's point of view so
    // it grazes the silhouette/dorsal edge instead of flooding the face the camera sees.
    const rim = new THREE.DirectionalLight(0xeaffff, 1.0); rim.position.set(-3, 3.2, -2.2); scene.add(rim);
    const rt = new THREE.WebGLRenderTarget(W, H);
    // Not sRGB: this target never gets three's automatic output-colourspace treatment regardless
    // of what we tag it (see the header's item 2) — tagging it accurately as linear documents
    // that `render()` below does the sRGB encode itself on readback, rather than implying the
    // bytes already are sRGB.
    rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    const camera = new THREE.PerspectiveCamera(28, W / H, 0.01, 200);
    const pivot = new THREE.Group();
    scene.add(pivot);
    const ctx2d = cv.getContext('2d');
    if (!ctx2d) return null;
    rig = { scene, camera, pivot, rt, w: W, h: H, ctx2d, img: ctx2d.createImageData(W, H), buf: new Uint8Array(W * H * 4), mesh: null, last: -1 };
    return rig;
  }

  function show(color: string, lenM: number, elongated = false): void {
    const r = ensureRig();
    if (!r) return;
    if (r.mesh) { r.pivot.remove(r.mesh); disposeMesh(r.mesh); }
    const mesh = makeFishMesh(color, lenM);
    applyPortraitMaterial(mesh);
    r.pivot.add(mesh);
    r.mesh = mesh;
    const cam = r.camera;
    const hf = 2 * Math.atan(Math.tan(cam.fov * Math.PI / 360) * cam.aspect);
    const len = lenM, d = (len * 1.18 / 2) / Math.tan(hf / 2) + lenM * 0.1;
    const dv = Math.max(d, (lenM * 0.4 * 1.4 / 2) / Math.tan(cam.fov * Math.PI / 360));
    cam.near = dv / 100; cam.far = Math.max(dv * 10, 40);
    // A slight three-quarter angle reads more like a photo than a dead-on profile (brief item
    // 5); long/billfish-shaped species foreshorten noticeably at that angle, so they stay close
    // to profile instead.
    const azimuth = elongated ? 0.12 : 0.40;
    cam.position.set(dv * Math.cos(azimuth), lenM * 0.1, dv * Math.sin(azimuth));
    // Aim a little above the fish's centre so it sits slightly low in frame (headroom) instead
    // of dead-centre.
    cam.lookAt(0, lenM * 0.18, 0);
    cam.updateProjectionMatrix();
    r.last = -1;
  }

  function render(renderer: THREE.WebGLRenderer, t: number): void {
    const r = rig;
    if (!r || !r.mesh) return;
    if (t - r.last < 0.12) return; // ~8fps is plenty for a slowly turning fish
    r.last = t;
    if (!r.scene.environment) r.scene.environment = ensureEnv(renderer);
    r.pivot.rotation.set(Math.sin(t * 1.3) * 0.05, Math.sin(t * 0.7) * 0.45, Math.sin(t * 1.1) * 0.06);
    const prevCol = renderer.getClearColor(new THREE.Color()), prevA = renderer.getClearAlpha();
    const prevT = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevSh = renderer.shadowMap.enabled;
    const exposure = renderer.toneMappingExposure; // read live — matches core/scene.ts without duplicating its value
    renderer.setRenderTarget(r.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.clear();
    renderer.render(r.scene, r.camera);
    renderer.readRenderTargetPixels(r.rt, 0, 0, r.w, r.h, r.buf);
    renderer.setRenderTarget(prevT);
    renderer.setClearColor(prevCol, prevA);
    renderer.autoClear = prevAuto;
    renderer.shadowMap.enabled = prevSh;
    const { w: W, h: H, buf: src } = r;
    const dst = r.img.data;
    const ldr = new Float64Array(3);
    const inv255 = 1 / 255;
    // Flip rows (GL reads bottom-up) and, per pixel, run the same ACES filmic curve + sRGB
    // gamma three's own output pipeline would have applied if it ran for render targets (see the
    // header's item 2 for why it doesn't) — src is still raw linear light values at this point.
    for (let y = 0; y < H; y++) {
      const srcRow = (H - 1 - y) * W * 4, dstRow = y * W * 4;
      for (let x = 0; x < W; x++) {
        const si = srcRow + x * 4, di = dstRow + x * 4;
        toLDR(src[si] * inv255, src[si + 1] * inv255, src[si + 2] * inv255, exposure, ldr);
        dst[di] = encodeSRGB(ldr[0]);
        dst[di + 1] = encodeSRGB(ldr[1]);
        dst[di + 2] = encodeSRGB(ldr[2]);
        dst[di + 3] = 255; // scene.background is always opaque now — no transparency to preserve
      }
    }
    r.ctx2d.putImageData(r.img, 0, 0);
  }

  function clear(): void {
    if (rig?.mesh) { rig.pivot.remove(rig.mesh); disposeMesh(rig.mesh); rig.mesh = null; }
  }

  return { show, render, clear };
}
