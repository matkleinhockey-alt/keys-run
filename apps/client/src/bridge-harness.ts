/**
 * Standalone verification harness for the Seven Mile Bridge rebuild
 * (apps/client/src/world/bridge.ts + world/bridge/**) — NOT part of the shipped game, same
 * purpose and pattern as src/reef-harness.ts (see that file's header for why a dedicated harness
 * exists at all on this branch: there's no way to fly a free camera around the real game yet).
 *
 * Reuses core/scene.ts (renderer/camera/sky/lighting) and the real world/water.ts +
 * world/islands.ts + core/shadows.ts (cascaded shadow maps) — this is the same rendering stack
 * the shipped game uses, not a simplified stand-in, so these screenshots are an honest preview of
 * how the bridge actually looks in-game, shadows included (the reference photo's bridge-shadow-
 * on-the-flats is part of what this task asks to honestly compare against).
 */
import { createScene } from './core/scene.js';
import { createCascadedShadows } from './core/shadows.js';
import { getQualitySettings } from './core/quality.js';
import { createWater } from './world/water.js';
import { createIslands } from './world/islands.js';
import { createBridge } from './world/bridge.js';

const wrap = document.getElementById('wrap');
if (!wrap) throw new Error('bridge-harness: #wrap not found');

const { renderer, scene, camera, sunDir, sun } = createScene(wrap);

const water = createWater(sunDir, 180);
scene.add(water.water);

const islands = createIslands();
scene.add(islands.group);

const bridge = createBridge();
scene.add(bridge.group);

const quality = getQualitySettings('ultra');
const shadows = createCascadedShadows(camera, scene, sunDir, quality.shadows);
shadows.registerCustomMaterial(water.material, water.baseOnBeforeCompile);
shadows.registerCustomMaterial(islands.frondMaterial, islands.frondBaseCompile);
shadows.applyToSubtree(scene);
shadows.setLight(sun.color, sun.intensity);

function resize(): void {
  const w = wrap!.clientWidth, h = wrap!.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  shadows.updateFrustums();
}
new ResizeObserver(resize).observe(wrap);
resize();

interface Waypoint { name: string; eye: [number, number, number]; look: [number, number, number] }

// Coordinates below were checked against the real build() output (see this module's report) —
// deck-height/shoreInfo probes at each x, not hand-guessed.
const WAYPOINTS: Waypoint[] = [
  // 1. Wide side-on: the humped high span (HUMP_X in world/bridge.ts, -3140 = the OLDBR gap's own
  // midpoint) from the south, far enough back to read the whole silhouette rise.
  { name: 'humped-span', eye: [-3140, 70, 118.3 + 560], look: [-3140, 14, 118.3] },
  // 2. Close pier view from water level: a normal-height new-bridge pier away from the hump
  // (x=-3500, deckH ~7.2 — see probe), framed low and close like a boat passing under it.
  { name: 'piers-water-level', eye: [-3512, 2.2, 147.0 - 14], look: [-3500, 5, 147.0] },
  // 3. Old bridge alongside new: x~-2850, both bridges present (new at dz=0, old at dz=-58),
  // Pigeon Key just ahead to the east.
  { name: 'old-and-new', eye: [-2960, 34, 97.5 + 220], look: [-2830, 8, 60] },
  // 4. Pigeon Key: the building row/palms/lawn (world/bridge/pigeon-key.ts), both bridges
  // visible passing it.
  { name: 'pigeon-key', eye: [-2650 - 150, 55, 84.3 + 230], look: [-2650, 6, 22] },
  // 5. Old bridge close-up, low and along its own length, to check the concrete arch ribs read
  // (x=-2900 is solid old-bridge deck+pile territory — see this module's report — clear of the
  // truss at -2812..-2740 and the no-deck stretch over the key itself).
  { name: 'old-bridge-arches', eye: [-2924, 2.6, 42.9 - 15], look: [-2840, 3.5, 51] },
];

interface HarnessApi {
  waypointNames: string[];
  goto(name: string): { name: string } | null;
  stats(): { calls: number; triangles: number };
  /** Isolates `createBridge()`'s own draw-call/triangle contribution by hiding its group,
   * re-rendering, then showing it again — same technique reef-harness.ts's `statsReefOnly` uses.
   * For the task's "report your delta" ask: this is the bridge subsystem's own number, independent
   * of whatever else (water/islands here, or reef/fish/clouds in the real game) happens to be
   * loaded alongside it. */
  statsBridgeOnly(): { withBridge: { calls: number; triangles: number }; withoutBridge: { calls: number; triangles: number } };
}

const api: HarnessApi = {
  waypointNames: WAYPOINTS.map((w) => w.name),
  goto(name) {
    const wp = WAYPOINTS.find((w) => w.name === name);
    if (!wp) return null;
    camera.position.set(...wp.eye);
    camera.lookAt(...wp.look);
    water.recenter(camera.position.x, camera.position.z);
    shadows.update(sunDir);
    return { name: wp.name };
  },
  stats() {
    return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  },
  statsBridgeOnly() {
    renderer.render(scene, camera);
    const withBridge = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    bridge.group.visible = false;
    renderer.render(scene, camera);
    const withoutBridge = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    bridge.group.visible = true;
    renderer.render(scene, camera);
    return { withBridge, withoutBridge };
  },
};
(window as unknown as { __bridgeHarness: HarnessApi }).__bridgeHarness = api;

water.update(0, 0, 0.9, 1);

function frame(): void {
  requestAnimationFrame(frame);
  renderer.render(scene, camera);
}
frame();
