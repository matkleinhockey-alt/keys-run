/**
 * Standalone verification harness for the reef (apps/client/src/world/reef/**) — NOT part of the
 * shipped game. There is no underwater/diver camera yet on `integration` (feat/diver and
 * feat/underwater-render are separate, not-yet-merged branches), so there is today no in-game way
 * to actually see the seafloor. This harness boots the minimum scene needed to look at the reef
 * honestly for the task's required screenshots (reef crest / mid-slope / wall / sand channel /
 * seagrass flat) and to read real draw-call/triangle counts off `renderer.info`.
 *
 * Reuses `core/scene.ts` (renderer/scene/camera) for the renderer/camera only. The backdrop
 * ground is deliberately NOT `world/seafloor.ts`'s `createSeafloor` (tried first; discarded — see
 * below). Everything reef-specific goes through the real `createReef()` — this harness does not
 * reimplement or fake any of it.
 *
 * ⚠ Why not `world/seafloor.ts`: its `floorY(d) = -(0.25 + min(d,14)*0.55)` is the exact hazard
 * docs/ARCHITECTURE.md's "Seafloor" section flags — it crushes every depth past 14 m to y≈-7.95.
 * This module's own `reefGroundY` (world/reef/terrain.ts) correctly seats coral at the real
 * `y = -depthAt(x,z)` per that file's integration-point note. Rendered together, those two
 * disagree by many metres at reef-wall depths (18-45 m), so `createSeafloor`'s plane sits far
 * above where the reef actually is and every coral instance renders floating in open water with
 * no visible ground — a convincing-looking bug that is entirely an artifact of mixing the OLD
 * flattened floor with the NEW correctly-seated reef, not of anything in this directory. The
 * seafloor agent's not-yet-merged rewrite (`seafloorHeightAt`) fixes this permanently; until then,
 * `verificationGround` below is a small harness-local stand-in using that exact same
 * `y = -depthAt(x,z)` formula (copying `createSeafloor`'s colour logic, read-only, for a
 * comparable look) so these screenshots honestly preview what the reef looks like sitting on
 * correct terrain, instead of failing the "Caribbean reef or scattered blobs?" check for a reason
 * that has nothing to do with the reef module itself.
 */
import * as THREE from 'three';
import { createScene } from './core/scene.js';
import { grainTex, normalTex } from './core/textures.js';
import { clamp, lerp } from './core/math.js';
import { createReef } from './world/reef/index.js';
import { placeChunk, worldToChunk, diveSiteAt } from './world/reef/placement.js';
import { chainZ } from '@keysrun/shared/world/chain';
import { depthAt } from '@keysrun/shared/world/depth';
import type { SpeciesId } from './world/reef/types.js';

const hash2 = (x: number, z: number): number => {
  const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

/**
 * A local ground patch coloured like `world/seafloor.ts`'s `createSeafloor` (sand/grass/rubble/
 * coral-rubble/deep bands) but height-correct: `y = -depthAt(x,z)`, matching `reefGroundY` exactly
 * so every placed instance's base sits flush with the ground under it. See this file's header for
 * why this exists instead of importing the real (soon-to-be-replaced) one.
 */
function verificationGround(x0: number, z0: number, width: number, height: number, segX: number, segY: number): THREE.Mesh {
  const g = new THREE.PlaneGeometry(width, height, segX, segY);
  g.rotateX(-Math.PI / 2);
  g.translate(x0 + width / 2, 0, z0 + height / 2);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const sand: [number, number, number] = [0.93, 0.86, 0.66];
  const grass: [number, number, number] = [0.33, 0.5, 0.26];
  const rubble: [number, number, number] = [0.6, 0.5, 0.38];
  const deep: [number, number, number] = [0.04, 0.12, 0.24];
  const CORAL: Array<[number, number, number]> = [[0.55, 0.33, 0.6], [0.85, 0.55, 0.3], [0.75, 0.68, 0.42], [0.5, 0.62, 0.4]];
  const L3 = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
    [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), d = depthAt(x, z), dz = z - chainZ(x);
    pos.setY(i, -d);
    const n = Math.sin(x * 0.05) * Math.cos(z * 0.043) + Math.sin(x * 0.013 + z * 0.021);
    let c = L3(sand, grass, clamp(n * 0.6 + 0.4 - (d < 1 ? 0.6 : 0), 0, 1) * (dz < 0 ? 0.9 : 0.55));
    if (dz > 1250 && dz < 1650 && d < 20) {
      c = L3(c, rubble, 0.6);
      if (hash2(x, z) > 0.8) c = CORAL[Math.floor(hash2(z, x) * 4)];
    }
    c = L3(c, deep, clamp((d - 14) / 30, 0, 1));
    const j = 0.94 + hash2(x * 0.7, z * 0.3) * 0.12;
    col[i * 3] = c[0] * j; col[i * 3 + 1] = c[1] * j; col[i * 3 + 2] = c[2] * j;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 1, map: grainTex([700, 700], 0.8, 1.1),
    normalMap: normalTex([300, 300], 0.45), normalScale: new THREE.Vector2(0.3, 0.3),
  }));
}

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

// Two local ground patches (not the full 8600x8600 world — this harness only ever frames five
// fixed waypoints) at 2 m/segment, honest ground height included — see verificationGround's
// header. One covers the reef-crest/mid-slope/wall/sand-channel cluster near Sombrero (x=250,
// dz~1300-1700, plus margin for findNear's search ring below); the other covers the seagrass
// flat out in Hawk Channel (x=-1500, z=27).
const seafloor = new THREE.Group();
seafloor.add(verificationGround(-150, 1100, 800, 700, 400, 350));
seafloor.add(verificationGround(-1750, -200, 500, 450, 250, 225));
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
  // Pulled back and raised from the first pass (eye was only ~8m out) — at this module's much
  // higher density (see this module's report) the nearest instance to any point is now close
  // enough that a tight framing ends up jammed inside one specimen's own branch crotch instead of
  // showing the reef as a whole. An establishing shot needs to actually step back.
  {
    const target = findNear(['elkhorn', 'staghorn'], 250, 1380.75, 3) ?? { x: 250, y: -5, z: 1380.75 };
    wps.push({ name: 'reef-crest', eye: [target.x - 11, target.y + 3.4, target.z - 11], look: [target.x, target.y + 0.8, target.z] });
  }

  // 2. Mid-slope: deeper along the same wall — staghorn/brain/star transition.
  {
    const target = findNear(['staghorn', 'brain', 'star'], 250, 1500, 3) ?? { x: 250, y: -12, z: 1500 };
    wps.push({ name: 'mid-slope', eye: [target.x - 12, target.y + 3.6, target.z - 12], look: [target.x, target.y + 0.8, target.z] });
  }

  // 3. The wall: deep drop-off — barrel/tube sponges and brain/star on ledges.
  {
    const target = findNear(['barrelSponge', 'tubeSponge', 'brain', 'star'], 250, 1610, 4) ?? { x: 250, y: -35, z: 1610 };
    wps.push({ name: 'the-wall', eye: [target.x - 12, target.y + 4.5, target.z - 7], look: [target.x, target.y + 1, target.z] });
  }

  // 4. Sand channel: the Sombrero spur-and-groove trough at x~276 (see placement.ts's
  // sandChannelFactor) — frame it from just outside, looking across the channel at the spurs on
  // either side so the bare-sand gap between coral heads actually reads in frame.
  {
    const cx0 = 276, cz0 = 1380.75;
    wps.push({ name: 'sand-channel', eye: [cx0 - 15, -5.5, cz0 - 3], look: [cx0 + 15, -6, cz0 + 3] });
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
  // Isolates this module's own contribution from the backdrop (the local verificationGround
  // patches — see this file's header) by hiding it, re-rendering once, and restoring it — so the
  // task's draw-call/triangle budget can be checked against the reef alone as well as the whole
  // scene.
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
