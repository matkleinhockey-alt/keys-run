/**
 * Standalone harness for the speargun entity (apps/client/src/entities/speargun), driven
 * directly by Playwright (test/spear.playwright.mjs) rather than through the full game loop.
 *
 * There is no diver/underwater mode on this branch yet (docs/ARCHITECTURE.md's diver is a
 * different agent's concurrent, unmerged work) — entities/speargun/index.ts was built against a
 * small local `DiverAimInput` interface for exactly this reason (see that module's header). This
 * harness plays the part of "the diver": a fixed position/aim and a synthetic `SpearTarget`
 * (there is no tier-3 tracked-fish registry yet either — see `getTargets`'s doc comment), so the
 * fire -> fly -> hit -> fight -> land path can be exercised and screenshotted end to end today.
 */
import * as THREE from 'three';
import { createSpeargun, type DiverAimInput, type SpearTarget } from '../src/entities/speargun/index.js';
import type { CaughtFishInfo } from '../src/game/catch/catch-flow.js';

const statusEl = document.getElementById('status')!;
function setStatus(s: string): void { statusEl.textContent = s; }

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d3b66);
scene.add(new THREE.HemisphereLight(0xcfe9ff, 0x0a3454, 1.1));
const dl = new THREE.DirectionalLight(0xffffff, 0.9);
dl.position.set(3, 4, 2);
scene.add(dl);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 100);
// Must be in the scene graph for createSpeargun's camera-attached gun view model to actually
// render — see core/scene.ts's createScene for the full explanation (a camera outside the scene
// still gets its own matrix updated by render(), but its *children* are never traversed/drawn).
scene.add(camera);

// The diver: fixed at the origin, looking straight down -z at a target fish 6 m out (well
// within SPEAR_RANGE's 11 m).
const diver: DiverAimInput = {
  position: { x: 0, y: -8, z: 0 },
  aimDir: { x: 0, y: 0, z: -1 },
  breath: 1,
};
camera.position.set(diver.position.x, diver.position.y, diver.position.z);
camera.lookAt(diver.position.x + diver.aimDir.x, diver.position.y + diver.aimDir.y, diver.position.z + diver.aimDir.z);

// A visible stand-in for the target fish — sim/spear.ts hit-tests against the capsule below,
// independent of this mesh, but the mesh lets a screenshot show *something* get speared.
const fishMesh = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.3, 0.9, 4, 8),
  new THREE.MeshStandardMaterial({ color: 0xe4572e }),
);
fishMesh.position.set(0, -8, -6);
fishMesh.rotation.z = Math.PI / 2;
scene.add(fishMesh);

const target: SpearTarget = {
  id: 'test-mutton', key: 'mutton', weight: 5.2,
  ax: fishMesh.position.x, ay: fishMesh.position.y, az: fishMesh.position.z + 0.45,
  bx: fishMesh.position.x, by: fishMesh.position.y, bz: fishMesh.position.z - 0.45,
  radius: 0.3,
};
let targetAlive = true;

let landed: CaughtFishInfo | null = null;
let wasActive = false;
let tornFree = false;
const speargun = createSpeargun({
  scene,
  camera,
  getTargets: () => (targetAlive ? [target] : []),
  onLanded(fish) { landed = fish; targetAlive = false; fishMesh.visible = false; },
});
// The view model now starts hidden by default (game/world.ts's `setDiveUI` is the one thing that
// shows it in the real game, on dive-entry) — this standalone harness has no dive mode at all, so
// it just shows it unconditionally, same as this file's previous always-visible behaviour.
speargun.setViewVisible(true);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

let hauling = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { speargun.tryFire(diver); }
  if (e.code === 'ArrowDown') { hauling = true; speargun.setHauling(true); }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'ArrowDown') { hauling = false; speargun.setHauling(false); }
});

let last = performance.now();
let t = 0;
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  t += dt;

  speargun.update(dt, t, diver, 0.9, 1);
  renderer.render(scene, camera);

  const fight = speargun.getFightState();
  const active = speargun.isActive();
  if (wasActive && !active && !landed) tornFree = true; // was fighting, now isn't, and didn't land
  wasActive = active;

  setStatus([
    `active: ${active}`,
    `hauling: ${hauling}`,
    `tension: ${fight ? fight.tension.toFixed(2) : '-'}`,
    landed ? `LANDED: ${landed.key} ${landed.weight.toFixed(1)} lb @ (${landed.x.toFixed(1)}, ${landed.z.toFixed(1)})` : tornFree ? 'TORN FREE' : 'landed: none',
  ].join('\n'));

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
