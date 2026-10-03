/**
 * Camera rig: third-person chase, first-person helm/tower drive views.
 *
 * Ported faithfully from legacy/index.html:3986-4059. Legacy's two "catch photo" camera
 * branches (`F.state==='caught'`) are still dropped — the catch-card view takes over the whole
 * screen (game/catch's `#card.photo` overlay) rather than repositioning this camera, so that
 * branch stays dead code here, same as Phase 0. The fishing-view branch (`fp.on`, legacy's
 * first-person-at-the-rod-tip camera) and the `F.state==='fight'`/`lineOut()` look-at targets in
 * the chase camera now read the real rod-fishing state machine (game/fishing/state.ts) instead
 * of Phase 0's always-false src/stubs.ts — this is the "later phase" those stubs' comments
 * anticipated.
 */
import * as THREE from 'three';
import type { BoatModel } from './boat/model.js';
import type { BoatState } from '@keysrun/shared/sim/boat';
import { clamp } from '../core/math.js';
import { F, lineOut, fishingActive } from '../game/fishing/state.js';

export interface CamState {
  yaw: number; zoom: number; dragging: boolean; lx: number; ly: number; pitchOff: number; shake: number;
}

export interface FpState {
  pref: boolean; on: boolean; yaw: number; pitch: number; userT: number;
  eyeL: THREE.Vector3; view: number; driveOn: boolean; dYaw: number; dPitch: number;
  qA: THREE.Quaternion; qB: THREE.Quaternion; eB: THREE.Euler; glance: boolean;
}

export function createCamState(): CamState {
  return { yaw: 0, zoom: 1, dragging: false, lx: 0, ly: 0, pitchOff: 0, shake: 0 };
}

export function createFpState(): FpState {
  return {
    pref: true, on: false, yaw: 0, pitch: -0.12, userT: 0, eyeL: new THREE.Vector3(),
    view: 0, driveOn: false, dYaw: 0, dPitch: 0, qA: new THREE.Quaternion(), qB: new THREE.Quaternion(), eB: new THREE.Euler(), glance: false,
  };
}

const angLerp = (a: number, b: number, t: number): number => {
  const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * Math.min(1, t);
};

export interface CameraDeps {
  camera: THREE.PerspectiveCamera;
  sky: THREE.Mesh;
  sunDisc: THREE.Mesh;
  sunDir: THREE.Vector3;
}

export function cycleView(fp: FpState, model: BoatModel | null): string {
  const hasTower = !!(model && model.tower);
  fp.view = (fp.view + 1) % (hasTower ? 3 : 2);
  return ['Third-person view', 'First person from the helm', 'First person from the tuna tower'][fp.view];
}

const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();

export function updateCamera(
  dt: number,
  deps: CameraDeps,
  cam: CamState,
  fp: FpState,
  model: BoatModel,
  boat: BoatState,
  gameRunning: boolean,
  hullLen: number,
): void {
  const { camera, sky, sunDisc, sunDir } = deps;
  const m = model;

  const want = gameRunning && fp.pref && fishingActive();
  if (want !== fp.on) {
    fp.on = want;
    camera.near = want ? 0.05 : 0.5;
    camera.updateProjectionMatrix();
    if (want) {
      fp.eyeL.copy(m.fishSpot);
      fp.yaw = lineOut() ? Math.atan2(-(F.bob.x - boat.x), -(F.bob.z - boat.z)) : boat.h - Math.PI / 2;
      fp.pitch = -0.12; fp.userT = 0;
    } else {
      camPos.copy(camera.position);
    }
  }
  const driveWant = gameRunning && fp.view > 0 && !fp.on;
  if (driveWant !== fp.driveOn) {
    fp.driveOn = driveWant;
    camera.near = (driveWant || fp.on) ? 0.05 : 0.5;
    camera.updateProjectionMatrix();
    fp.dYaw = 0; fp.dPitch = 0;
    if (!driveWant) camPos.copy(camera.position);
  }
  cam.shake = Math.max(0, cam.shake - dt * 2.5);

  if (fp.on) {
    m.group.updateMatrixWorld(true);
    fp.eyeL.lerp(m.fishSpot, Math.min(1, dt * 3));
    const eye = m.group.localToWorld(tmpV.copy(fp.eyeL).add(tmpV2.set(0, 1.62, 0)));
    camera.position.copy(eye);
    let tgt: THREE.Vector3 | null = null;
    if (F.state === 'fight') tgt = tmpV2.set(F.fx, 0, F.fz);
    else if (lineOut()) tgt = tmpV2.copy(F.bob as unknown as THREE.Vector3);
    if (tgt && fp.userT <= 0 && !F.charging) {
      const dx = tgt.x - eye.x, dz = tgt.z - eye.z, hd = Math.hypot(dx, dz) || 1;
      fp.yaw = angLerp(fp.yaw, Math.atan2(-dx, -dz), dt * 2.5);
      fp.pitch = THREE.MathUtils.lerp(fp.pitch, clamp(Math.atan2(tgt.y - eye.y, hd) + 0.06, -0.7, 0.3), Math.min(1, dt * 2.5));
    }
    fp.userT -= dt;
    camera.rotation.set(fp.pitch + (Math.random() - 0.5) * cam.shake * 0.03, fp.yaw, 0, 'YXZ');
  } else if (fp.driveOn) {
    m.group.updateMatrixWorld(true);
    const loc = fp.view === 2 && m.tower ? tmpV.copy(m.tower.pos).add(tmpV2.set(0, 1.62, 0)) : tmpV.copy(m.helmPos).add(tmpV2.set(0, 1.66, -0.05));
    camera.position.copy(m.group.localToWorld(loc));
    if (fp.glance && !cam.dragging) {
      fp.dYaw *= 1 - Math.min(1, dt * 4);
      fp.dPitch = THREE.MathUtils.lerp(fp.dPitch, fp.view === 2 ? -0.62 : -0.5, Math.min(1, dt * 4));
    } else if (!cam.dragging) {
      fp.dYaw *= 1 - Math.min(1, dt * 1.2);
      fp.dPitch *= 1 - Math.min(1, dt * 1.2);
    }
    m.group.getWorldQuaternion(fp.qA);
    fp.qB.setFromEuler(fp.eB.set(fp.dPitch - (fp.view === 2 ? 0.16 : 0.2), fp.dYaw, 0, 'YXZ'));
    camera.quaternion.copy(fp.qA).multiply(fp.qB);
    if (cam.shake > 0) camera.position.add(tmpV.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(cam.shake * 0.15));
  } else {
    const dist = (hullLen * 1.5 + 11) * cam.zoom, ht = (hullLen * 0.32 + 4.2) * cam.zoom * (1 + cam.pitchOff);
    if (!cam.dragging && Math.abs(boat.speed) > 5) cam.yaw *= 1 - Math.min(1, dt * 1.2);
    const a = boat.h + cam.yaw;
    tmpV.set(boat.x + Math.sin(a) * dist, boat.y + ht, boat.z + Math.cos(a) * dist);
    if (!gameRunning) {
      const tt = performance.now() / 1000 * 0.08;
      tmpV.set(boat.x + Math.sin(tt) * dist * 1.3, boat.y + ht * 1.2, boat.z + Math.cos(tt) * dist * 1.3);
    }
    camPos.lerp(tmpV, 1 - Math.exp(-dt * 4));
    let lx = boat.x - Math.sin(boat.h) * 4, lz = boat.z - Math.cos(boat.h) * 4;
    if (F.state === 'fight') { lx = THREE.MathUtils.lerp(boat.x, F.fx, 0.35); lz = THREE.MathUtils.lerp(boat.z, F.fz, 0.35); }
    else if (lineOut()) { lx = THREE.MathUtils.lerp(boat.x, F.bob.x, 0.35); lz = THREE.MathUtils.lerp(boat.z, F.bob.z, 0.35); }
    tmpV2.set(lx, boat.y + 1.8, lz);
    camLook.lerp(tmpV2, 1 - Math.exp(-dt * 5));
    camera.position.copy(camPos);
    if (cam.shake > 0) camera.position.add(tmpV.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(cam.shake * 0.6));
    camera.lookAt(camLook);
  }
  camera.updateMatrixWorld(true);
  sky.position.copy(camera.position);
  sunDisc.position.copy(camera.position).addScaledVector(sunDir, 5000);
  sunDisc.lookAt(camera.position);
}

export function bindCameraPointerControls(canvas: HTMLCanvasElement, cam: CamState, fp: FpState): void {
  canvas.addEventListener('pointerdown', (e) => {
    cam.dragging = true; cam.lx = e.clientX; cam.ly = e.clientY;
    canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!cam.dragging) return;
    const dx = e.clientX - cam.lx, dy = e.clientY - cam.ly;
    cam.lx = e.clientX; cam.ly = e.clientY;
    if (fp.driveOn && !fp.on) { fp.dYaw -= dx * 0.004; fp.dPitch = clamp(fp.dPitch - dy * 0.004, -1, 0.7); }
    else if (fp.on) { fp.yaw -= dx * 0.004; fp.pitch = clamp(fp.pitch - dy * 0.004, -1.1, 0.6); fp.userT = 2.5; }
    else { cam.yaw -= dx * 0.006; cam.pitchOff = clamp(cam.pitchOff + dy * 0.004, -0.5, 1.2); }
  });
  const endDrag = () => { cam.dragging = false; canvas.style.cursor = 'grab'; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.zoom = clamp(cam.zoom * (1 + Math.sign(e.deltaY) * 0.1), 0.55, 2.6);
  }, { passive: false });
}
