/**
 * Standalone verification harness for the reef (apps/client/src/world/reef/**) — NOT part of the
 * shipped game. There is no underwater/diver camera yet on `integration` (feat/diver and
 * feat/underwater-render are separate, not-yet-merged branches), so there is today no in-game way
 * to actually see the seafloor. This harness boots the minimum scene needed to look at the reef
 * honestly for the task's required screenshots (reef crest / mid-slope / wall / sand channel /
 * seagrass flat) and to read real draw-call/triangle counts off `renderer.info`.
 *
 * Reuses `core/scene.ts` (renderer/scene/camera) and `world/seafloor.ts` (today's flattened
 * `createSeafloor`, read-only import — the real chunked terrain is a different agent's
 * not-yet-merged work; see world/reef/terrain.ts's integration-point note) purely as a backdrop.
 * Everything reef-specific goes through the real `createReef()` — this harness does not
 * reimplement or fake any of it.
 */
import * as THREE from 'three';
import { createScene } from './core/scene.js';
import { createSeafloor } from './world/seafloor.js';
import { createReef } from './world/reef/index.js';
import { placeChunk, worldToChunk, diveSiteAt } from './world/reef/placement.js';
import { WORLD } from '@keysrun/shared/world/depth';
import type { SpeciesId } from './world/reef/types.js';

const wrap = document.getElementById('wrap');
if (!wrap) throw new Error('reef-harness: #wrap not found');

const { renderer, scene, camera } = createScene(wrap);
camera.near = 0.3;
camera.far = 2000;

// Minimal lighting — this harness doesn't need time-of-day or shadows, just enough to read
// material colour/normal-map detail clearly.
scene.add(new THREE.AmbientLight(0x4a6a74, 1.1));
const sun = new THREE.DirectionalLight(0xdfeeff, 1.6);
sun.position.set(40, 80, 20);
scene.add(sun);

// Stand-in underwater fog, matching docs/ARCHITECTURE.md's visibility table (10-25 m depending on
// band) — real per-channel-extinction colour grading is world/underwater/**'s job, not this
// module's; this is only so the screenshots are an honest read of what the reef will look like
// once that fog exists, not a judgement made in unrealistic full-visibility daylight.
scene.fog = new THREE.Fog(0x1a5f6e, 2, 24);
scene.background = new THREE.Color(0x0c3240);

const seafloor = createSeafloor(WORLD.x0, WORLD.z0, WORLD.size);
scene.add(seafloor);

const reef = createReef();
scene.add(reef.group);

function resize(): void {
  const w = wrap!.clientWidth, h = wrap!.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(wrap);
resize();

/** Finds the nearest placed instance of one of `species` to (tx,tz), searching the chunk under
 * that point plus a ring of neighbours — so each waypoint below actually frames real, resident
 * coral instead of a hand-guessed coordinate that might land on empty sand. */
function findNear(species: SpeciesId[], tx: number, tz: number, ringChunks = 3): { x: number; y: number; z: number } | null {
  const { cx, cz } = worldToChunk(tx, tz);
  let best: { x: number; y: number; z: number; d: number } | null = null;
  for (let dx = -ringChunks; dx <= ringChunks; dx++) {
    for (let dz = -ringChunks; dz <= ringChunks; dz++) {
      const placement = placeChunk(cx + dx, cz + dz);
      for (const id of species) {
        for (const inst of placement[id] ?? []) {
          const d = Math.hypot(inst.x - tx, inst.z - tz);
          if (!best || d < best.d) best = { x: inst.x, y: inst.y, z: inst.z, d };
        }
      }
    }
  }
  return best ? { x: best.x, y: best.y, z: best.z } : null;
}

interface Waypoint { name: string; eye: [number, number, number]; look: [number, number, number] }

function buildWaypoints(): Waypoint[] {
  const wps: Waypoint[] = [];

  // 1. Reef crest: Sombrero anchor, shallow/high-energy — aim at an elkhorn/staghorn cluster.
  {
    const target = findNear(['elkhorn', 'staghorn'], 250, 1380.75, 3) ?? { x: 250, y: -5, z: 1380.75 };
    wps.push({ name: 'reef-crest', eye: [target.x - 6, target.y + 2.2, target.z - 6], look: [target.x, target.y + 0.6, target.z] });
  }

  // 2. Mid-slope: deeper along the same wall — staghorn/brain/star transition.
  {
    const target = findNear(['staghorn', 'brain', 'star'], 250, 1500, 3) ?? { x: 250, y: -12, z: 1500 };
    wps.push({ name: 'mid-slope', eye: [target.x - 7, target.y + 2.5, target.z - 7], look: [target.x, target.y + 0.5, target.z] });
  }

  // 3. The wall: deep drop-off — barrel/tube sponges and brain/star on ledges.
  {
    const target = findNear(['barrelSponge', 'tubeSponge', 'brain', 'star'], 250, 1610, 4) ?? { x: 250, y: -35, z: 1610 };
    wps.push({ name: 'the-wall', eye: [target.x - 8, target.y + 3, target.z - 4], look: [target.x, target.y + 0.5, target.z] });
  }

  // 4. Sand channel: the Sombrero spur-and-groove trough at x~276 (see placement.ts's
  // sandChannelFactor) — frame it from just outside, looking across the channel at the spurs on
  // either side so the bare-sand gap between coral heads actually reads in frame.
  {
    const cx0 = 276, cz0 = 1380.75;
    wps.push({ name: 'sand-channel', eye: [cx0 - 10, -4, cz0 - 2], look: [cx0 + 10, -5, cz0 + 2] });
  }

  // 5. Seagrass flat: shallow Hawk Channel flats, well clear of the reef/any patch.
  {
    const target = findNear(['seagrass'], -1500, 27, 3) ?? { x: -1500, y: -2.2, z: 27 };
    wps.push({ name: 'seagrass-flat', eye: [target.x - 5, target.y + 1.6, target.z - 5], look: [target.x, target.y + 0.3, target.z] });
  }

  return wps;
}

const waypoints = buildWaypoints();

interface HarnessApi {
  waypointNames: string[];
  goto(name: string): { name: string; eye: [number, number, number] } | null;
  stats(): { calls: number; triangles: number };
  statsReefOnly(): { calls: number; triangles: number };
  diveSite(x: number, z: number): ReturnType<typeof diveSiteAt>;
  debugCounts(): ReturnType<typeof reef.debugCounts>;
}

const api: HarnessApi = {
  waypointNames: waypoints.map((w) => w.name),
  goto(name: string) {
    const wp = waypoints.find((w) => w.name === name);
    if (!wp) return null;
    camera.position.set(...wp.eye);
    camera.lookAt(...wp.look);
    reef.update(camera.position.x, camera.position.z);
    return { name: wp.name, eye: wp.eye };
  },
  stats() {
    return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  },
  // Isolates this module's own contribution from the backdrop (today's flattened, soon-replaced
  // world/seafloor.ts plane — see this file's header) by hiding it, re-rendering once, and
  // restoring it — so the task's draw-call/triangle budget can be checked against the reef alone
  // as well as the whole scene.
  statsReefOnly() {
    seafloor.visible = false;
    renderer.render(scene, camera);
    const stats = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    seafloor.visible = true;
    renderer.render(scene, camera);
    return stats;
  },
  diveSite(x: number, z: number) {
    return diveSiteAt(x, z);
  },
  debugCounts() {
    return reef.debugCounts();
  },
};
(window as unknown as { __reefHarness: HarnessApi }).__reefHarness = api;

function frame(): void {
  requestAnimationFrame(frame);
  reef.update(camera.position.x, camera.position.z);
  renderer.render(scene, camera);
}
frame();
