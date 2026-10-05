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
 *
 * The render-target/readback plumbing and the colour-pipeline fix (item 2) now live in
 * render-pipeline.ts, shared with underwater-trophy.ts's dive-caught card — extracted verbatim,
 * not rewritten, when that module needed the exact same machinery. See that file's header.
 */
import * as THREE from 'three';
import { makeFishMesh } from '../fishing/fish-mesh.js';
import { buildOffscreenRig, readback, buildGradientEnv, type OffscreenRig } from './render-pipeline.js';

interface PortraitRig extends OffscreenRig {
  pivot: THREE.Group;
  mesh: THREE.Group | null;
  last: number;
}

export interface Portrait {
  show(color: string, lenM: number, elongated?: boolean): void;
  render(renderer: THREE.WebGLRenderer, t: number): void;
  clear(): void;
}

// ---- environment (see header item 1) ---------------------------------------------------------

/** Built once, lazily, the first time a portrait is ever rendered — cached for the life of the
 * page so every catch after the first one is free. A small custom sky/water gradient rather than
 * three/examples/jsm's `RoomEnvironment`: a fish held up for a photo should reflect sky and water,
 * not a grey interior, and this avoids introducing a new `three/examples/jsm` import path. */
let sharedEnv: THREE.Texture | null = null;
function ensureEnv(renderer: THREE.WebGLRenderer): THREE.Texture {
  if (sharedEnv) return sharedEnv;
  sharedEnv = buildGradientEnv(renderer, {
    top: 0xdcefec, horizon: 0x1f6f73, deep: 0x041824,
    // A bright "sun" patch gives the PMREM convolution something to turn into a soft specular
    // highlight at low roughness; a cooler bounce patch opposite it stops one flank going flat.
    accent: { color: 0xfff2d9, intensity: 5, pos: [14, 22, -8], radius: 3 },
    bounce: { color: 0x2f8aa8, intensity: 1.6, pos: [-16, -4, 10], radius: 5 },
  });
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
    const camera = new THREE.PerspectiveCamera(28, (cv?.width || 640) / (cv?.height || 300), 0.01, 200);
    const base = buildOffscreenRig(canvasId, scene, camera);
    if (!base) return null;
    const pivot = new THREE.Group();
    scene.add(pivot);
    rig = { ...base, pivot, mesh: null, last: -1 };
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
    // Padding bumped from the legacy-ported 1.18/1.4 (brief item 5's "frame with a little
    // headroom" — the original padding left the nose/tail/dorsal line touching the canvas edge
    // with zero margin; this was already true before any change in this file, not a regression
    // introduced by the lighting/material work above).
    const len = lenM, d = (len * 1.6 / 2) / Math.tan(hf / 2) + lenM * 0.1;
    const dv = Math.max(d, (lenM * 0.4 * 1.9 / 2) / Math.tan(cam.fov * Math.PI / 360));
    cam.near = dv / 100; cam.far = Math.max(dv * 10, 40);
    // A slight three-quarter angle reads more like a photo than a dead-on profile (brief item
    // 5); long/billfish-shaped species foreshorten noticeably at that angle, so they stay close
    // to profile instead. `dv` above is calibrated for a broadside/profile view, where every
    // point along the fish's length is equidistant from the camera; orbiting the camera around
    // the subject at that same *radius* instead pulls it closer to the near tip (this length is
    // comparable to the camera distance, so that parallax is large, not a rounding error — it
    // was clipping the nose/tail badly in testing). Side-stepping instead — keeping the camera's
    // perpendicular (x) distance at the safe `dv` and only offsetting it sideways — gives the
    // same viewing angle without that extra closeness.
    const azimuth = elongated ? 0.12 : 0.40;
    cam.position.set(dv, lenM * 0.1, dv * Math.tan(azimuth));
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
    readback(renderer, r);
  }

  function clear(): void {
    if (rig?.mesh) { rig.pivot.remove(rig.mesh); disposeMesh(rig.mesh); rig.mesh = null; }
  }

  return { show, render, clear };
}
