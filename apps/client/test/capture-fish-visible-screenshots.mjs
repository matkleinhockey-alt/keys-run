/**
 * Fish-VISIBILITY regression screenshots — task brief: "there are no visible fish in the water."
 *
 * Root cause this verifies the fix for: `fishWorld.update`'s population `focus` (game/world.ts)
 * used to be `curState` (the boat) unconditionally, even while `diver.mode === 'diver'`. A diver
 * who swims away from an anchored boat left the population system still activating schools
 * around the boat's position — so a camera placed on the reef crest while the boat sat back at
 * the marina saw *zero* fish, exactly as reported ("drove out, placed a camera underwater on the
 * Sombrero Reef crest at x=60, y=-2.0, z=1462 ... not a single fish in the frame"). The fix
 * (game/world.ts's frame loop + entities/fish/index.ts's `update` signature) makes `focus` follow
 * the diver while diving, independent of the boat's own position (still passed through as its own
 * standing threat).
 *
 * This script does NOT co-locate the boat with the dive target the way
 * capture-fish-density-screenshots.mjs's `teleport` does — that would hide exactly the bug being
 * fixed. The boat is left at its normal spawn point (Boot Key Harbor, ~1.6 km from the reef crest)
 * for every underwater shot; only the real diver system (`window.__diverDebug`, game/world.ts) is
 * used to place the viewer, and the real THREE.PerspectiveCamera (updateDiverCamera) renders the
 * shot — not a synthetic debug camera override. The one topside shot drives the real boat instead.
 *
 * This sandbox renders on a software/virtualised GPU — generous waits, no fps claims. Draw-call
 * and triangle counts ARE real (renderer.info, read via the profiler HUD).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5191';

// Species with V.level === 'surface' in packages/shared/src/content/creatures.ts — pelagics that
// swim just under the surface regardless of total water-column depth. A mid-column eye height
// (this script's default for reef/flats residents, which are 'mid'/'bottom') puts the camera
// 20-25 m below where these actually are once offshore depth reaches 40-50 m, framing empty blue
// water instead of the school. Confirmed directly: the first pass at this script put the camera at
// the offshore column's 50% depth and only caught 2 of 10 blackfin tuna clipped at the frame edge.
const SURFACE_LEVEL_SPECIES = new Set([
  'mahi', 'blackfin', 'wahoo', 'sailfish', 'yellowfin', 'bluefin', 'albacore', 'marlin',
  'blackmarlin', 'swordfish', 'kingfish', 'flyingfish', 'dolphin', 'cero',
]);
const OUT = path.join(HERE, 'screenshots', 'fish-visible');
fs.mkdirSync(OUT, { recursive: true });

async function readProfiler(page) {
  const text = await page.evaluate(() => {
    const el = document.getElementById('profilerHud');
    return el ? el.textContent : null;
  });
  if (!text) return null;
  const calls = /draw calls\s+(\d+)/.exec(text)?.[1];
  const tris = /triangles\s+([\d.]+)k/.exec(text)?.[1];
  return { calls: calls ? Number(calls) : null, trianglesK: tris ? Number(tris) : null, raw: text };
}

async function activeSchools(page) {
  return page.evaluate(() => window.__fishDebug.activeSchools());
}

async function poolStats(page) {
  return page.evaluate(() => window.__fishDebug.poolStats());
}

function summarizeFishLoad(schools, pools) {
  const fishCount = schools.reduce((s, sc) => s + sc.count, 0);
  const totalTri = pools.reduce((s, p) => s + p.meshCount * p.triPerInstance, 0);
  return {
    schools: schools.length,
    fishCount,
    speciesInUse: pools.length,
    fishDrawCalls: pools.length, // one InstancedMesh (= one draw call) per in-use species pool
    fishTrianglesK: Math.round(totalTri / 1000),
    bySpecies: pools.map((p) => `${p.type}:${p.inUse}`).join(', '),
  };
}

/** Dives for real via the diver controller — `enterAt` calls `diver.enterWater` under the hood
 * (switching `diver.mode` to 'diver', which is exactly the branch game/world.ts's frame loop now
 * reads to pick the fish-population focus), then snaps straight to depth/position. The boat is
 * left wherever it already is — see this file's header. */
async function diveAt(page, x, z, depth, yaw) {
  await page.evaluate(({ x, z, depth, yaw }) => {
    window.__diverDebug.enterAt(depth, x, z, yaw);
  }, { x, z, depth, yaw });
}

async function setLook(page, yaw, pitch) {
  await page.evaluate(({ yaw, pitch }) => window.__diverDebug.setLook(yaw, pitch), { yaw, pitch });
}

async function exitToBoat(page) {
  await page.evaluate(() => window.__diverDebug.exitToBoat());
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(800);
await page.click('#btnGo');
await page.waitForTimeout(1000);
await page.keyboard.press('KeyP'); // profiler HUD on
await page.waitForTimeout(300);

const report = [];

/**
 * Two-phase per location:
 *  (a) dive at the literal requested coordinate and hold — this is what proves the *fix*: the
 *      population system activated schools around the diver (not the boat, which never moves from
 *      spawn in this script). Screenshot `${name}-wide.png` + instance counts come from here.
 *  (b) underwater visibility is only ~20-30 m (depth-bands.ts) and resident/roamer schools can
 *      activate anywhere within a 220-320 m radius of the focus, so the *nearest* school to the
 *      requested point is not guaranteed to be in frame from an arbitrary look direction — same
 *      reason capture-fish-density-screenshots.mjs always frames a specific resident's anchor from
 *      a close standoff rather than shooting blind. Re-aim the same real diver at the nearest
 *      currently-active school's centroid, close enough to actually read as fish, and take the
 *      shot that's meant to be *looked at* (`${name}.png`).
 */
async function diveShot(name, x, z, depth, yaw, waitMs = 3000) {
  await diveAt(page, x, z, depth, yaw);
  await setLook(page, yaw, -0.08);
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: path.join(OUT, `${name}-wide.png`) });
  const schools = await activeSchools(page);
  const pools = await poolStats(page);
  const prof = await readProfiler(page);
  const mode = await page.evaluate(() => window.__diverDebug.mode());
  const diverState = await page.evaluate(() => {
    const s = window.__diverDebug.state();
    return s ? { x: s.x, y: s.y, z: s.z } : null;
  });

  // Prefer the *biggest* nearby school as the anchor, not merely the closest — a lone fish 20 m
  // away photographs as a failure ("fewer than ~10 visible fish ... is a failure") even though the
  // fix worked. Candidates are capped to a radius generous enough to cover anything the earlier
  // activeSchools() snapshot found while still being close enough for underwater visibility
  // (~20-30 m, depth-bands.ts) to matter once framed.
  const CANDIDATE_RADIUS = 150;
  let anchor = null;
  for (const s of schools) {
    const d = Math.hypot(s.cx - x, s.cz - z);
    if (d > CANDIDATE_RADIUS) continue;
    if (!anchor || s.count > anchor.count || (s.count === anchor.count && d < anchor.d)) anchor = { ...s, d };
  }
  if (!anchor) {
    for (const s of schools) {
      const d = Math.hypot(s.cx - x, s.cz - z);
      if (!anchor || d < anchor.d) anchor = { ...s, d };
    }
  }

  let framed = null;
  if (anchor) {
    // A real Keys reef patch holds several small, independently-placed schools close together
    // (confirmed directly: a probe near the bug report's own x=60,z=1462 found 8+ separate
    // 1-3-member schools within 60 m of each other) — a single camera angle that only frames the
    // one biggest school undersells that. Cluster every active school within CLUSTER_RADIUS of the
    // anchor's centroid and frame the group, not just the anchor alone.
    const CLUSTER_RADIUS = 30;
    const cluster = schools.filter((s) => Math.hypot(s.cx - anchor.cx, s.cz - anchor.cz) <= CLUSTER_RADIUS);
    const clusterCount = cluster.reduce((sum, s) => sum + s.count, 0);
    // View *broadside* to the anchor school's own heading: stepMember (school.ts) spreads members
    // along the heading-relative lateral axis (rx,rz = cos(heading),-sin(heading)) far more than
    // along the forward axis, so standing behind/ahead of the school (looking along its heading)
    // projects that lateral spread across the screen's horizontal width — the widest possible read
    // of "a school", rather than end-on where members mostly overlap each other.
    const fx = -Math.sin(anchor.heading), fz = -Math.cos(anchor.heading);
    const standoff = 8;
    const camX = anchor.cx - fx * standoff, camZ = anchor.cz - fz * standoff;
    const newYaw = Math.atan2(-(anchor.cx - camX), -(anchor.cz - camZ));
    const col = await page.evaluate(({ tx, tz }) => window.__fishDebug.waterColumnAt(tx, tz, performance.now() / 1000), { tx: anchor.cx, tz: anchor.cz });
    // 'surface'-level species (school.ts: y = surf - 0.5 - (oy+1)*0.15) hold just under the
    // surface regardless of total column depth — a mid-column fraction is badly wrong for them
    // once offshore depth reaches 40-50 m (see SURFACE_LEVEL_SPECIES above). Pitch up slightly
    // since the camera sits a touch below them looking toward the surface.
    const isSurface = SURFACE_LEVEL_SPECIES.has(anchor.type);
    const eyeY = isSurface ? col.surf - 1.6 : col.floor + (col.surf - col.floor) * 0.5;
    const pitch = isSurface ? 0.08 : -0.05;
    await diveAt(page, camX, camZ, Math.max(0.3, -eyeY), newYaw);
    await setLook(page, newYaw, pitch);
    await page.waitForTimeout(1000);
    framed = {
      anchorType: anchor.type, anchorCount: anchor.count, distanceFromRequested: Math.round(anchor.d),
      clusterSchools: cluster.length, clusterFishCount: clusterCount, clusterSpecies: cluster.map((s) => `${s.type}:${s.count}`).join(', '),
    };
  }
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const prof2 = await readProfiler(page);

  report.push({
    shot: name, requested: { x, z, depth }, diverMode: mode, diverState,
    wide: summarizeFishLoad(schools, pools), wideProfiler: prof,
    framed, framedProfiler: prof2,
  });
  await exitToBoat(page);
  await page.waitForTimeout(400);
}

// 1. THE EXACT BUG REPORT LOCATION — Sombrero Reef crest, x=60, y=-2.0 (depth 2.0), z=1462,
// looking along the reef (yaw=PI/2 faces -x, i.e. along the dz~1462 crest line, matching
// docs/ARCHITECTURE.md's "reef wall sits at dz 1460-1650" band orientation).
await diveShot('01-reef-crest-x60-z1462', 60, 1462, 2.0, Math.PI / 2);

// 2. Reef wall / drop (deeper band of the same reef, ZONE_LIFE.ReefWall territory — depthAt here
// is ~16.6 m, past REEF_WALL_DEPTH=12, confirmed via packages/shared's depthAt/zoneAt directly).
await diveShot('02-reef-wall-deep', -200, 1520, 11, Math.PI / 2);

// 3. Hawk Channel — mixed mid-water (depthAt ~6.75 m, zoneAt === 'Hawk Channel').
await diveShot('03-hawk-channel', 0, 700, 4.5, 0);

// 4. The flats — shallow, bonefish/stingray territory (depthAt ~2.2 m, zoneAt === 'Flats',
// confirmed clear of shore — shoreInfo(x,z).d ~34 m).
await diveShot('04-flats', -600, 700, 1.6, 0);

// 5. Offshore — pelagic roamers only, no residents (depthAt ~50 m, zoneAt === 'Offshore').
await diveShot('05-offshore', 0, 2300, 5, 0, 4500);

// 6. The Humps — Marathon Hump's real world position (HUMPS entry is `{x:-500, dz:3350}`; actual
// z = chainZ(x) + dz = 3353, computed directly from packages/shared rather than guessed).
await diveShot('06-humps', -500, 3353, 10, 0, 4000);

// 7. Topside, from the helm — real boat, real chase camera, no diver debug at all. Finds a real
// dolphin-pod/tarpon/stingray resident or roamer first (same approach as
// capture-fish-density-screenshots.mjs's "surface-from-helm" shot) so the boat is actually aimed
// at something, then drives the boat there via window.__fishDebug.teleport.
{
  const HAWK_ORIGIN = { x: 0, z: 700 };
  const FLATS_ORIGIN = { x: -600, z: 700 };
  let hit = await page.evaluate(({ x, z }) => window.__fishDebug.findResidentNear('dolphin', x, z, 3000), HAWK_ORIGIN);
  if (!hit) hit = await page.evaluate(({ x, z }) => window.__fishDebug.findResidentNear('tarpon', x, z, 3000), HAWK_ORIGIN);
  if (!hit) hit = await page.evaluate(({ x, z }) => window.__fishDebug.findResidentNear('stingray', x, z, 3000), FLATS_ORIGIN);
  const target = hit || HAWK_ORIGIN;
  const standoff = 28;
  const originX = target.x + standoff, originZ = target.z;
  const heading = Math.atan2(-(target.x - originX), -(target.z - originZ));
  await page.evaluate(() => { delete window.__fishDebugCamera; });
  await page.evaluate(({ x, z, h }) => window.__fishDebug.teleport(x, z, h), { x: originX, z: originZ, h: heading });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(OUT, '07-topside-helm.png') });
  const schools = await activeSchools(page);
  const pools = await poolStats(page);
  const prof = await readProfiler(page);
  report.push({ shot: 'topside-helm', at: target, ...summarizeFishLoad(schools, pools), profiler: prof });
}

console.log(JSON.stringify(report, null, 2));
console.log('console errors:', consoleErrors);
await browser.close();
console.log('done');
