/**
 * Standalone harness for the rod view model, the segmented third-person rod and the line
 * (apps/client/src/game/fishing/{rod-viewmodel,rod-bend,visuals}.ts), driven by Playwright
 * (test/capture-rod.mjs). Same reason as spear-harness.ts: the full game renders at ~3 fps on this
 * sandbox's software GL and the fixed-step accumulator clamps to 50 ms per frame, so a real fight
 * takes minutes of wall clock to reach a given load. The harness steps the REAL modules (the same
 * `createRodViewModel`, `createFishingVisuals`, and `startFight`/`stepFight`) in simulated time,
 * deterministically, and renders on demand.
 */
import * as THREE from 'three';
import { createRodViewModel } from '../src/game/fishing/rod-viewmodel.js';
import { createFishingVisuals } from '../src/game/fishing/visuals.js';
import { F } from '../src/game/fishing/state.js';
import { fightParamsFor, startFight, stepFight } from '@keysrun/shared/sim/fight';
import { mulberry32 } from '@keysrun/shared/rng';
import type { BoatModel } from '../src/entities/boat/model.js';
import type { BoatState } from '@keysrun/shared/sim/boat';

const statusEl = document.getElementById('status')!;
const W = window.innerWidth, H = window.innerHeight;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd0ee);
scene.fog = new THREE.Fog(0x9fd0ee, 40, 140);
scene.add(new THREE.HemisphereLight(0xdff1ff, 0x1a4d6e, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(6, 10, 4);
scene.add(sun);
const sea = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1b6d8f, roughness: 0.35 }));
sea.position.y = -0.05;
scene.add(sea);

const camera = new THREE.PerspectiveCamera(65, W / H, 0.05, 400);
camera.position.set(0, 1.7, 0);
scene.add(camera);
const rodVM = createRodViewModel(camera);
const visuals = createFishingVisuals(scene);

// Stand-in for the boat model's rod: the same rigid 3 m cylinder entities/boat/model.ts builds.
const rodPivot = new THREE.Group();
rodPivot.rotation.order = 'YXZ';
rodPivot.add(new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.04, 3, 6).translate(0, 1.5, 0), new THREE.MeshStandardMaterial({ color: 0x1c1f24 })));
rodPivot.position.set(0.5, 1.0, 0);
scene.add(rodPivot);
const model = { rodPivot } as unknown as BoatModel;
const boat = { wakeRing: new Float32Array(0) } as unknown as BoatState;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
document.body.appendChild(renderer.domElement);

const DT = 1 / 30;
const SHIFT_X = -500, SHIFT_Z = 6000;
let simT = 0;
let fpOn = true;
let reeling = false;
const params = fightParamsFor('yellowfin', 70, 3);
const rng = mulberry32(5);

function startHooked(): void {
  F.state = 'fight';
  // The sim runs in a shifted frame (open Gulf Stream water: (0,0) is on Vaca Key and a fish there
  // is cut off in the mangroves on tick one); the scene stays at the origin.
  F.fx = 2; F.fz = -34; F.bob = { x: 2, y: 0, z: -34 };
  F.fightParams = params;
  F.fight = startFight(params, SHIFT_X + F.fx, SHIFT_Z + F.fz, rng);
  visuals.showHooked('#d9b43c', 1.4);
}

/** Pin the load (and optionally the clutch state) and let the rod spring settle for `sec` s. */
function hold(tension: number, sec: number, extra: { slipping?: boolean; lineSpeed?: number; limit?: number } = {}): void {
  for (let i = 0; i < Math.round(sec / DT); i++) {
    if (!F.fight) return;
    F.fight = { ...F.fight, tension, shake: 0, slipping: extra.slipping ?? false, lineSpeed: extra.lineSpeed ?? 0, limit: extra.limit ?? 1 };
    tick(DT);
  }
}

function tick(dt: number): void {
  simT += dt;
  rodPivot.rotation.x = -(1.0 + Math.min(1, F.fight?.tension ?? 0) * 0.3);
  rodVM.update(dt, fpOn, reeling, reeling, model);
  scene.updateMatrixWorld(true);
  const tip = new THREE.Vector3();
  rodVM.lineTip(model, fpOn).getWorldPosition(tip);
  visuals.drawLine(simT, boat, 0, 0, tip);
  if (F.fight) visuals.updateHooked(simT, dt, F.fight.running, F.fight.shake, 0, false);
}

/** Verification override: when set, draw() uses this camera placement instead of the two canned
 * ones, so a close-up of a specific part (the reel) can be framed without a full game boot. */
let camOverride: { p: [number, number, number]; look: [number, number, number] } | null = null;

function draw(): void {
  if (camOverride) {
    camera.position.set(...camOverride.p);
    camera.lookAt(...camOverride.look);
  } else if (!fpOn) {
    camera.position.set(3.4, 2.4, 3.2);
    camera.lookAt(0.3, 2.2, -6);
  } else {
    camera.position.set(0, 1.7, 0);
    camera.rotation.set(0, 0, 0);
  }
  scene.updateMatrixWorld(true);
  renderer.render(scene, camera);
  statusEl.textContent = `T=${(F.fight?.tension ?? 0).toFixed(2)}  fp=${fpOn}`;
}

rodPivot.visible = false; // the game hides the boat rod in first person (fishing/index.ts render)
startHooked();
tick(DT);
draw();

(window as unknown as Record<string, unknown>).__rod = {
  hold: (t: number, s: number, x?: { slipping?: boolean; lineSpeed?: number; limit?: number }) => { hold(t, s, x); draw(); },
  kick: (m: number) => { rodVM.kick(m); },
  recoil: (l: number) => { rodVM.recoil(l); },
  /** Release the load at once and step `sec` seconds, as when the hook pulls. */
  release: (sec: number) => { if (F.fight) { F.fight = { ...F.fight, tension: 0 }; } for (let i = 0; i < Math.round(sec / DT); i++) { if (F.fight) F.fight = { ...F.fight, tension: 0, slipping: false, shake: 0 }; tick(DT); } draw(); },
  step: (sec: number) => { for (let i = 0; i < Math.round(sec / DT); i++) tick(DT); draw(); },
  setFp: (v: boolean) => { fpOn = v; rodVM.group.visible = v; rodPivot.visible = !v; draw(); },
  setReeling: (v: boolean) => { reeling = v; },
  /** Frame an arbitrary close-up; pass null to go back to the canned views. */
  cam: (p: [number, number, number] | null, look?: [number, number, number]) => {
    camOverride = p ? { p, look: look ?? [0, 0, 0] } : null;
    draw();
  },
  /** The first-person rod hangs off the camera, so moving the camera moves the rod with it and
   * it can never be orbited. This re-parents it into the scene at a fixed spot so a close-up of
   * the reel (or anything else on it) can actually be framed. Pass false to put it back. */
  inspect: (on: boolean) => {
    if (on) {
      scene.add(rodVM.group);
      rodVM.group.position.set(0, 1.4, -1.2);
      rodVM.group.rotation.set(0, 0, 0);
      rodVM.group.visible = true;
    } else {
      camera.add(rodVM.group);
      rodVM.group.position.set(0, 0, 0);
      rodVM.group.rotation.set(0, 0, 0);
    }
    draw();
  },
  /** World position of the reel, so a caller can aim `cam` at it without guessing. */
  reelAt: () => { const v = new THREE.Vector3(); rodVM.group.updateMatrixWorld(true); const r = rodVM.group.getObjectByName('reel'); r?.getWorldPosition(v); return r ? [v.x, v.y, v.z] : null; },
  /** Real physics: advance the actual fight with a given policy for `sec` s and report. */
  realFight: (sec: number) => {
    let s = F.fight!;
    for (let i = 0; i < Math.round(sec / DT) && s.outcome === 'fighting'; i++) {
      const held = s.tension < 0.5 && !s.airborne && !s.running;
      reeling = held;
      s = stepFight(s, { reeling: held }, params, { boatX: SHIFT_X, boatZ: SHIFT_Z }, rng, DT);
      F.fight = s; F.fx = s.x - SHIFT_X; F.fz = s.z - SHIFT_Z;
      for (const ev of s.events) if (ev.type === 'shock') rodVM.kick(ev.mag);
      tick(DT);
    }
    draw();
    return { outcome: s.outcome, tension: s.tension, dist: s.dist, stam: s.stam, slipping: s.slipping };
  },
  state: () => ({ tension: F.fight?.tension, outcome: F.fight?.outcome }),
};
