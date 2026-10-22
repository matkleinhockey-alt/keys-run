/**
 * Land camera: first person at eye height, or a third-person chase over the shoulder. Drag to
 * look, like the diver rig; `cam.yaw` is also the walker's `lookYaw`, so "where you look" and
 * "which way W goes" are the same number.
 *
 * ## near/far
 * The boat camera is near 0.5 (it has a 1,900 m horizon to serve). That is too coarse on foot:
 * walking up to a wall at 0.5 m clips straight through it. Land mode narrows `near` to
 * `LAND_CAMERA_NEAR` and leaves `far` alone (the town skyline and the harbour are still the view).
 * It is restored by the facade on the way out (entities/land/index.ts) — leaving it at 0.08 topside
 * would quietly cost the whole sea depth precision, the same trap entities/diver/camera.ts warns
 * about in the other direction.
 *
 * ## Third person and walls
 * A chase camera 3.6 m behind you will happily sit inside the building you just walked into. The
 * boom is shortened until its end is clear of every collider (same rects the walker uses), and
 * kept above the floor, so stepping through the diner door pulls the camera in rather than
 * showing you the back of a wall.
 */
import * as THREE from 'three';
import type { WalkerState } from '@keysrun/shared/sim/walker';
import type { Rect } from '@keysrun/shared/world/town';

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

export type LandCamMode = 'first' | 'third';

export interface LandCamState {
  yaw: number; pitch: number; mode: LandCamMode;
  dragging: boolean; lx: number; ly: number;
}

export function createLandCamState(yaw = 0): LandCamState {
  return { yaw, pitch: -0.05, mode: 'first', dragging: false, lx: 0, ly: 0 };
}

export function cycleLandView(cam: LandCamState): string {
  cam.mode = cam.mode === 'first' ? 'third' : 'first';
  return cam.mode === 'first' ? 'First person' : 'Third person';
}

export function bindLandPointerControls(canvas: HTMLCanvasElement, cam: LandCamState, isActive: () => boolean): () => void {
  const onDown = (e: PointerEvent): void => {
    if (!isActive()) return;
    cam.dragging = true; cam.lx = e.clientX; cam.ly = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent): void => {
    if (!isActive() || !cam.dragging) return;
    const dx = e.clientX - cam.lx, dy = e.clientY - cam.ly;
    cam.lx = e.clientX; cam.ly = e.clientY;
    cam.yaw -= dx * 0.0042;
    cam.pitch = clamp(cam.pitch - dy * 0.0042, -1.25, 1.25);
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

export const LAND_CAMERA_NEAR = 0.08;
export const EYE_HEIGHT = 1.62;
const FOV_FIRST = 72, FOV_THIRD = 62;
const BOOM = 3.7;

const _tmp = new THREE.Vector3();

function blocked(colliders: readonly Rect[], x: number, z: number): boolean {
  const r = 0.28;
  for (const c of colliders) if (x > c.x0 - r && x < c.x1 + r && z > c.z0 - r && z < c.z1 + r) return true;
  return false;
}

export function updateLandCamera(
  camera: THREE.PerspectiveCamera, cam: LandCamState, w: WalkerState,
  dt: number, colliders: readonly Rect[], insideRoof: boolean,
): void {
  const wantFov = cam.mode === 'first' ? FOV_FIRST : FOV_THIRD;
  camera.fov += (wantFov - camera.fov) * Math.min(1, dt * 4);
  camera.near = LAND_CAMERA_NEAR;
  camera.updateProjectionMatrix();

  if (cam.mode === 'first') {
    // a little head bob that scales with how fast you are going, and none when standing
    const bob = Math.sin(w.gait * 2) * 0.035 * Math.min(1, w.speed / 2.4);
    camera.position.set(w.x, w.y + EYE_HEIGHT + bob, w.z);
    camera.rotation.set(cam.pitch, cam.yaw, 0, 'YXZ');
    return;
  }
  const fx = -Math.sin(cam.yaw) * Math.cos(cam.pitch), fy = Math.sin(cam.pitch), fz = -Math.cos(cam.yaw) * Math.cos(cam.pitch);
  const tx = w.x, ty = w.y + 1.45, tz = w.z;
  let boom = insideRoof ? 2.4 : BOOM;
  // shorten until the boom's end is clear of walls
  for (let i = 0; i < 12 && boom > 0.4; i++) {
    if (!blocked(colliders, tx - fx * boom, tz - fz * boom)) break;
    boom -= 0.35;
  }
  _tmp.set(tx - fx * boom, Math.max(w.y + 0.35, ty - fy * boom + 0.4), tz - fz * boom);
  camera.position.copy(_tmp);
  camera.lookAt(tx, ty - 0.1, tz);
}
