/**
 * Diver camera rig: two modes (dive-mask first-person, and a third-person "chase your fins"
 * view), both driven by the same `cam.yaw`/`cam.pitch` pointer-drag look — which is also fed
 * straight into `DiverInput.lookYaw/lookPitch` (entities/diver/controller.ts), so "look" and
 * "steer" are deliberately the same number, per docs/ARCHITECTURE.md's "look-to-steer".
 *
 * The dive-mask FOV is narrower than the boat's (a real mask narrows your field of view and
 * magnifies ~25-30%), and narrows further still as air runs low — the doc's "tunnel vision"
 * read two ways: a few degrees of real FOV narrowing here, plus the stronger CSS vignette in
 * ui (apps/client/src/entities/diver/hud.ts's `#blackout` element).
 *
 * ⚠ near/far: this is also where world/underwater/caustics.ts's documented precision bug gets
 * fixed for real gameplay (it explicitly calls this out as the fix). The topside camera keeps a
 * 0.5-9000 near/far for its ~1,900 m horizon; underwater visibility never exceeds ~30 m (depth-
 * bands.ts's own table), so holding onto that 18,000:1 ratio while submerged leaves almost no
 * depth-buffer precision for caustics' world-position reconstruction (confirmed: a 180,000:1
 * ratio with the old debug camera's near=0.05/far=9000). `DIVE_CAMERA_NEAR`/`DIVE_CAMERA_FAR`
 * give a ~1,000:1 ratio instead, with far reaching past the terrain's own submerged mid-ring
 * (world/terrain/lod.ts's SUBMERGED profile, 60 m) so the seafloor never clips out from under a
 * diver looking along the reef wall. game/world.ts restores the topside near/far the instant the
 * diver climbs back aboard (see its mode-change handling) — leaving this applied topside would
 * otherwise silently reintroduce the same precision problem up there, and clip the 1,900 m skirt.
 */
import * as THREE from 'three';
import { AIR_MAX, type DiverState } from '@keysrun/shared/sim/diver';

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

export type DiverCamMode = 'mask' | 'chase';

export interface DiverCamState {
  yaw: number;
  pitch: number;
  mode: DiverCamMode;
  dragging: boolean;
  lx: number;
  ly: number;
}

export function createDiverCamState(yaw = 0): DiverCamState {
  return { yaw, pitch: -0.1, mode: 'mask', dragging: false, lx: 0, ly: 0 };
}

export function cycleDiverView(cam: DiverCamState): string {
  cam.mode = cam.mode === 'mask' ? 'chase' : 'mask';
  return cam.mode === 'mask' ? 'Dive mask view' : 'Chase view';
}

/** Pointer-drag look, gated by `isActive` exactly like entities/diver/input.ts's key handlers —
 * bound/unbound per dive (see controller.ts) rather than left live, so a drag that started while
 * driving the boat never bleeds a diver-mode look delta in. */
export function bindDiverPointerControls(canvas: HTMLCanvasElement, cam: DiverCamState, isActive: () => boolean): () => void {
  const onDown = (e: PointerEvent): void => {
    if (!isActive()) return;
    cam.dragging = true; cam.lx = e.clientX; cam.ly = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent): void => {
    if (!isActive() || !cam.dragging) return;
    const dx = e.clientX - cam.lx, dy = e.clientY - cam.ly;
    cam.lx = e.clientX; cam.ly = e.clientY;
    cam.yaw -= dx * 0.0045;
    cam.pitch = clamp(cam.pitch - dy * 0.0045, -1.3, 1.3);
  };
  const onUp = (): void => { cam.dragging = false; };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    cam.dragging = false;
  };
}

const MASK_FOV = 72;
const SURFACE_FOV = 58; // matches core/scene.ts's boat default, so breaching the surface doesn't pop
const TUNNEL_MIN_FOV = 34;
const EYE_HEIGHT = 0.15;

/** See this file's header. Exported so game/world.ts's mode-change handling can name exactly what
 * it's restoring away from when the diver climbs back aboard. */
export const DIVE_CAMERA_NEAR = 0.05;
export const DIVE_CAMERA_FAR = 60;

const tmpPos = new THREE.Vector3();

export function updateDiverCamera(camera: THREE.PerspectiveCamera, cam: DiverCamState, state: DiverState, t: number, dt: number): void {
  const depth = Math.max(0, -state.y);
  const airFrac = clamp(state.air / AIR_MAX, 0, 1);
  const tunnel = airFrac < 0.25 ? Math.min(1, (0.25 - airFrac) / 0.25) : 0;
  const baseFov = depth > 0.15 ? MASK_FOV : SURFACE_FOV;
  const wantFov = baseFov - (baseFov - TUNNEL_MIN_FOV) * tunnel;
  camera.fov += (wantFov - camera.fov) * Math.min(1, dt * 3);
  camera.near = DIVE_CAMERA_NEAR;
  camera.far = DIVE_CAMERA_FAR;
  camera.updateProjectionMatrix();

  const fx = -Math.sin(cam.yaw) * Math.cos(cam.pitch);
  const fy = Math.sin(cam.pitch);
  const fz = -Math.cos(cam.yaw) * Math.cos(cam.pitch);

  if (cam.mode === 'mask') {
    // A faint idle sway — narcosis (sim/diver.ts's flag) exaggerates it, standing in for the
    // doc's "reticle sway"; the real visual warp is the renderer's to add later.
    const swayK = state.narcosis ? 2.2 : 1;
    const sway = Math.sin(t * 1.3) * 0.015 * swayK;
    camera.position.set(state.x, state.y + EYE_HEIGHT, state.z);
    camera.rotation.set(cam.pitch + sway, cam.yaw, Math.cos(t * 0.9) * 0.01 * swayK, 'YXZ');
  } else {
    tmpPos.set(state.x - fx * 3.4, state.y + 1.1 - fy * 1.2, state.z - fz * 3.4);
    camera.position.copy(tmpPos);
    camera.lookAt(state.x, state.y + EYE_HEIGHT, state.z);
  }
}
