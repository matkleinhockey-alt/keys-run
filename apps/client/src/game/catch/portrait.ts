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
  show(color: string, lenM: number): void;
  render(renderer: THREE.WebGLRenderer, t: number): void;
  clear(): void;
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
    scene.add(new THREE.HemisphereLight(0xffffff, 0x2a4a66, 1.15));
    const dl = new THREE.DirectionalLight(0xffffff, 1.3); dl.position.set(3, 4, 2); scene.add(dl);
    const rl = new THREE.DirectionalLight(0x9fd8ff, 0.5); rl.position.set(-3, 1, -2); scene.add(rl);
    const rt = new THREE.WebGLRenderTarget(W, H);
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const camera = new THREE.PerspectiveCamera(28, W / H, 0.01, 200);
    const pivot = new THREE.Group();
    scene.add(pivot);
    const ctx2d = cv.getContext('2d');
    if (!ctx2d) return null;
    rig = { scene, camera, pivot, rt, w: W, h: H, ctx2d, img: ctx2d.createImageData(W, H), buf: new Uint8Array(W * H * 4), mesh: null, last: -1 };
    return rig;
  }

  function show(color: string, lenM: number): void {
    const r = ensureRig();
    if (!r) return;
    if (r.mesh) r.pivot.remove(r.mesh);
    const mesh = makeFishMesh(color, lenM);
    r.pivot.add(mesh);
    r.mesh = mesh;
    const cam = r.camera;
    const hf = 2 * Math.atan(Math.tan(cam.fov * Math.PI / 360) * cam.aspect);
    const len = lenM, d = (len * 1.18 / 2) / Math.tan(hf / 2) + lenM * 0.1;
    const dv = Math.max(d, (lenM * 0.4 * 1.4 / 2) / Math.tan(cam.fov * Math.PI / 360));
    cam.near = dv / 100; cam.far = dv * 10;
    cam.position.set(dv, lenM * 0.08, 0);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    r.last = -1;
  }

  function render(renderer: THREE.WebGLRenderer, t: number): void {
    const r = rig;
    if (!r || !r.mesh) return;
    if (t - r.last < 0.12) return; // ~8fps is plenty for a slowly turning fish
    r.last = t;
    r.pivot.rotation.set(Math.sin(t * 1.3) * 0.05, Math.sin(t * 0.7) * 0.45, Math.sin(t * 1.1) * 0.06);
    const prevCol = renderer.getClearColor(new THREE.Color()), prevA = renderer.getClearAlpha();
    const prevT = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevSh = renderer.shadowMap.enabled;
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
    for (let y = 0; y < H; y++) dst.set(src.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4); // flip rows: GL reads bottom-up
    r.ctx2d.putImageData(r.img, 0, 0);
  }

  function clear(): void {
    if (rig?.mesh) { rig.pivot.remove(rig.mesh); rig.mesh = null; }
  }

  return { show, render, clear };
}
