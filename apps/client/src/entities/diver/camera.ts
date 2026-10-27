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
import { type DiverState } from '@keysrun/shared/sim/diver';
import type { HandWobble } from '@keysrun/shared/sim/steady';
import { beginGesture, moveGesture, type Gesture } from './gesture.js';

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

export type DiverCamMode = 'mask' | 'chase';

export interface DiverCamState {
  yaw: number;
  pitch: number;
  mode: DiverCamMode;
  /** True while a press that has become a LOOK is held (entities/diver/gesture.ts) — an
   * undecided press, which may yet turn out to be a tap that fires the gun, is not a drag. */
  dragging: boolean;
  /** Smoothed yaw rate (rad/s) of the look, for the camera's bank into a turn. */
  yawRate: number;
  prevYaw: number;
}

export function createDiverCamState(yaw = 0): DiverCamState {
  return { yaw, pitch: -0.1, mode: 'mask', dragging: false, yawRate: 0, prevYaw: yaw };
}

export function cycleDiverView(cam: DiverCamState): string {
  cam.mode = cam.mode === 'mask' ? 'chase' : 'mask';
  return cam.mode === 'mask' ? 'Dive mask view' : 'Chase view';
}

/** True while the diver owns the mouse — see `bindDiverPointerControls`. Exported so
 * entities/speargun/input.ts can fire on the press instead of classifying it as a tap or a drag,
 * because under the lock there is no drag to tell it apart from. */
export function diverMouseLocked(canvas: HTMLCanvasElement): boolean {
  return document.pointerLockElement === canvas;
}

/**
 * Mouse look, gated by `isActive` exactly like entities/diver/input.ts's key handlers —
 * bound/unbound per dive (see controller.ts) rather than left live, so a look that started while
 * driving the boat never bleeds a diver-mode delta in.
 *
 * Aiming is the mouse, not a drag. It used to be drag-only: you held the left button and pulled
 * to swing the view, which meant the one button you aim with is the same one you shoot with, and
 * every shot had to be disambiguated from a turn by how far the press travelled. Clicking the
 * canvas now takes the pointer lock and the gun follows the mouse directly, the way the pistol
 * already works (entities/handgun/input.ts, whose refusal handling this mirrors).
 *
 * The drag path stays as the fallback, because the lock can be refused and touch has no lock at
 * all: without a button held, `moveGesture` is never started and nothing moves, so on a phone
 * this would be a camera you cannot turn.
 */
export function bindDiverPointerControls(canvas: HTMLCanvasElement, cam: DiverCamState, isActive: () => boolean): () => void {
  let g: Gesture | null = null;
  const locked = (): boolean => document.pointerLockElement === canvas;
  const requestLock = (): void => {
    if (locked()) return;
    // A refusal arrives two ways and both must be swallowed — see the pistol's own note. The
    // synchronous throw is the dangerous one: letting it escape would abort the rest of `onDown`
    // and the drag fallback would never start, leaving a diver who cannot look at all.
    try {
      const r = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (r && typeof r.catch === 'function') r.catch(() => undefined);
    } catch { /* refused — the drag fallback below is the answer */ }
  };
  const onMouseMove = (e: MouseEvent): void => {
    if (!isActive() || !locked()) return;
    cam.yaw -= e.movementX * 0.0022;
    cam.pitch = clamp(cam.pitch - e.movementY * 0.0022, -1.3, 1.3);
  };
  document.addEventListener('mousemove', onMouseMove);

  const onDown = (e: PointerEvent): void => {
    if (!isActive() || e.button !== 0) return;
    // Mouse: take the lock and aim with the mouse from here on. Touch (and a refused lock) fall
    // through to the drag gesture.
    if (e.pointerType === 'mouse' && !locked()) requestLock();
    if (locked()) return; // the mouse owns the aim; nothing to drag
    if (g) return;
    g = beginGesture(e.pointerId, e.clientX, e.clientY);
    // `requestPointerLock` resolves asynchronously, so the line above still runs on the click
    // that takes the lock — and capturing a pointer the lock is in the middle of claiming throws
    // `InvalidStateError`. Capture is only a nicety for the drag fallback (it keeps a drag alive
    // if the cursor leaves the canvas), so a refusal is not worth propagating.
    try { canvas.setPointerCapture(e.pointerId); } catch { /* fallback drag works without it */ }
  };
  const onMove = (e: PointerEvent): void => {
    if (!g || e.pointerId !== g.id || !isActive()) return;
    const { dx, dy } = moveGesture(g, e.clientX, e.clientY);
    if (g.kind === 'look') cam.dragging = true;
    if (dx === 0 && dy === 0) return;
    cam.yaw -= dx * 0.0045;
    cam.pitch = clamp(cam.pitch - dy * 0.0045, -1.3, 1.3);
  };
  const onUp = (e: PointerEvent): void => {
    if (!g || e.pointerId !== g.id) return;
    g = null; cam.dragging = false;
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  return () => {
    document.removeEventListener('mousemove', onMouseMove);
    if (locked()) document.exitPointerLock();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    g = null; cam.dragging = false;
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

export function updateDiverCamera(camera: THREE.PerspectiveCamera, cam: DiverCamState, state: DiverState, t: number, dt: number, hand?: HandWobble): void {
  const depth = Math.max(0, -state.y);
  const airFrac = clamp(state.air / state.airMax, 0, 1);
  const tunnel = airFrac < 0.25 ? Math.min(1, (0.25 - airFrac) / 0.25) : 0;
  const baseFov = depth > 0.15 ? MASK_FOV : SURFACE_FOV;
  // Speed widens the view a little (sprinting reads as speed, not just a faster number), capped so
  // it never fights the tunnel-vision narrowing at low air.
  const speed = Math.hypot(state.vx, state.vy, state.vz);
  const wantFov = baseFov - (baseFov - TUNNEL_MIN_FOV) * tunnel + Math.min(4, speed * 1.5) * (1 - tunnel);

  // Look rate, smoothed, for banking into a turn. Differenced here (not in the pointer handler)
  // because yaw can also be set directly (debug hooks, enterWater), and wrapping a teleport-sized
  // jump into the bank would roll the view over.
  const rawRate = dt > 0 ? (cam.yaw - cam.prevYaw) / dt : 0;
  cam.prevYaw = cam.yaw;
  cam.yawRate += (clamp(rawRate, -6, 6) - cam.yawRate) * Math.min(1, dt * 8);
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
    // `hand` (food/drink): steady hands divide this idle sway; a drink adds visible roll/drift on
    // top. Camera-only, like the kick surge below: yaw/pitch (the aim) are untouched, so drunk
    // diving is silly but never changes where you steer or how fast you burn air.
    const sway = Math.sin(t * 1.3) * 0.015 * swayK * (hand?.ampMul ?? 1);
    // Kick stroke: the head surges forward with each fin stroke and dips slightly on the recovery
    // (state.kickPhase, sim/diver.ts), scaled by speed so a coast is smooth. Roll banks into a
    // turn (negative yaw rate = turning right = roll right). Both are camera-only: aim comes from
    // yaw/pitch alone, so none of this moves where a shot goes.
    const stroke = state.kicking ? Math.max(0, Math.sin(state.kickPhase * Math.PI * 2)) : 0;
    const surge = stroke * 0.05 * Math.min(1, speed / 1.2);
    const bank = clamp(cam.yawRate * 0.03, -0.1, 0.1);
    camera.position.set(state.x + fx * surge, state.y + EYE_HEIGHT + fy * surge - stroke * 0.012, state.z + fz * surge);
    camera.rotation.set(cam.pitch + sway + stroke * 0.006 + (hand?.pitch ?? 0), cam.yaw + (hand?.yaw ?? 0), Math.cos(t * 0.9) * 0.01 * swayK * (hand?.ampMul ?? 1) + bank + (hand?.roll ?? 0), 'YXZ');
  } else {
    tmpPos.set(state.x - fx * 3.4, state.y + 1.1 - fy * 1.2, state.z - fz * 3.4);
    camera.position.copy(tmpPos);
    camera.lookAt(state.x, state.y + EYE_HEIGHT, state.z);
  }
}
