/**
 * Fish-DENSITY verification screenshots (task brief: "the flats, Hawk Channel, the reef,
 * offshore, and a surface shot from the helm showing life around the boat"). Saved to
 * test/screenshots/fish-density/. Separate from capture-fish-screenshots.mjs (that one verifies
 * individual species/behaviour close-up; this one is about whether the *world* feels populated).
 *
 * Reuses the same window.__fishDebug dev-only hooks (game/world.ts) as capture-fish-screenshots.mjs
 * — see that file's header for why this needs no real gameplay backdoor.
 *
 * This sandbox renders on a software/virtualised GPU — generous waits, no fps claims. Draw-call
 * and triangle counts ARE real (renderer.info, read via the profiler HUD), fps is not.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5191';
const OUT = path.join(HERE, 'screenshots', 'fish-density');
fs.mkdirSync(OUT, { recursive: true });

async function teleportAndSettle(page, x, z, waitMs = 1800) {
  await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z), { x, z });
  await page.waitForTimeout(waitMs);
}

async function lookAtFromBoatSide(page, targetX, targetZ, standoff, levelT, originX, originZ) {
  const dx = originX - targetX, dz = originZ - targetZ;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  await teleportAndSettle(page, targetX + ux * 60, targetZ + uz * 60);
  const tgtCol = await page.evaluate(({ targetX, targetZ }) => window.__fishDebug.waterColumnAt(targetX, targetZ, performance.now() / 1000), { targetX, targetZ });
  const y = tgtCol.floor + (tgtCol.surf - tgtCol.floor) * levelT;
  const cx = targetX + ux * standoff, cz = targetZ + uz * standoff;
  await page.evaluate(({ cx, cz, y, targetX, targetZ }) => {
    window.__fishDebugCamera = { x: cx, y, z: cz, lookX: targetX, lookY: y, lookZ: targetZ };
  }, { cx, cz, y, targetX, targetZ });
  await page.waitForTimeout(700);
}

async function findSpecies(page, type, originX, originZ, radius) {
  return page.evaluate(({ type, originX, originZ, radius }) => window.__fishDebug.findResidentNear(type, originX, originZ, radius), { type, originX, originZ, radius });
}

async function activeSchools(page) {
  return page.evaluate(() => window.__fishDebug.activeSchools());
}

async function poolStats(page) {
  return page.evaluate(() => window.__fishDebug.poolStats());
}

async function readProfilerStats(page) {
  // profiler.stats getter isn't on window, but the HUD text is — parse it back out.
  const text = await page.evaluate(() => {
    const el = document.getElementById('profilerHud');
    return el ? el.textContent : null;
  });
  if (!text) return null;
  const calls = /draw calls\s+(\d+)/.exec(text)?.[1];
  const tris = /triangles\s+([\d.]+)k/.exec(text)?.[1];
  return { calls: calls ? Number(calls) : null, trianglesK: tris ? Number(tris) : null, raw: text };
}

function summarizeFishLoad(schools, pools) {
  const fishCount = schools.reduce((s, sc) => s + sc.count, 0);
  const totalTri = pools.reduce((s, p) => s + p.meshCount * p.triPerInstance, 0);
  const totalDraws = pools.length;
  return { schools: schools.length, fishCount, fishDrawCalls: totalDraws, fishTrianglesK: Math.round(totalTri / 1000) };
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

// Open-water reference points, all confirmed clear of islands by the existing fish verification
// script (REEF_ORIGIN) or derived along the same clear x=0 meridian.
const REEF_ORIGIN = { x: 0, z: 1550 };
const FLATS_ORIGIN = { x: -1150, z: 320 };
const HAWK_ORIGIN = { x: 0, z: 700 };
const OFFSHORE_ORIGIN = { x: 0, z: 2300 };

const report = [];

// 1. The flats — bonefish on the sand, worst case is "scattered individuals", we want a readable school.
{
  const hit = await findSpecies(page, 'bonefish', FLATS_ORIGIN.x, FLATS_ORIGIN.z, 2500);
  if (hit) {
    await lookAtFromBoatSide(page, hit.x, hit.z, 10, 0.55, FLATS_ORIGIN.x, FLATS_ORIGIN.z);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, '01-flats.png') });
    const schools = await activeSchools(page), pools = await poolStats(page), prof = await readProfilerStats(page);
    report.push({ shot: 'flats', at: hit, ...summarizeFishLoad(schools, pools), profiler: prof });
  } else {
    report.push({ shot: 'flats', error: 'no bonefish resident found' });
  }
}

// 2. Hawk Channel — mixed mid-water: look for a cero or mangrove-snapper resident.
{
  let hit = await findSpecies(page, 'cero', HAWK_ORIGIN.x, HAWK_ORIGIN.z, 2500);
  if (!hit) hit = await findSpecies(page, 'mangrove', HAWK_ORIGIN.x, HAWK_ORIGIN.z, 2500);
  if (hit) {
    await lookAtFromBoatSide(page, hit.x, hit.z, 10, 0.5, HAWK_ORIGIN.x, HAWK_ORIGIN.z);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, '02-hawk-channel.png') });
    const schools = await activeSchools(page), pools = await poolStats(page), prof = await readProfilerStats(page);
    report.push({ shot: 'hawk-channel', at: hit, ...summarizeFishLoad(schools, pools), profiler: prof });
  } else {
    report.push({ shot: 'hawk-channel', error: 'no resident found' });
  }
}

// 3. The reef — dense yellowtail school, worst-case draw/triangle measurement point.
{
  const hit = await findSpecies(page, 'yellowtail', REEF_ORIGIN.x, REEF_ORIGIN.z, 1500);
  if (hit) {
    await lookAtFromBoatSide(page, hit.x, hit.z, 7, 0.5, REEF_ORIGIN.x, REEF_ORIGIN.z);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, '03-reef.png') });
    const schools = await activeSchools(page), pools = await poolStats(page), prof = await readProfilerStats(page);
    report.push({ shot: 'reef', at: hit, ...summarizeFishLoad(schools, pools), profiler: prof });
  } else {
    report.push({ shot: 'reef', error: 'no yellowtail resident found' });
  }
}

// 3b (bonus). Reef wall — grouper/amberjack holding on the drop (ZONE_LIFE.ReefWall).
{
  const hit = await findSpecies(page, 'grouper', REEF_ORIGIN.x, REEF_ORIGIN.z + 150, 1500);
  if (hit) {
    await lookAtFromBoatSide(page, hit.x, hit.z, 9, 0.35, REEF_ORIGIN.x, REEF_ORIGIN.z);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, '03b-reef-wall.png') });
    const schools = await activeSchools(page), pools = await poolStats(page), prof = await readProfilerStats(page);
    report.push({ shot: 'reef-wall', at: hit, ...summarizeFishLoad(schools, pools), profiler: prof });
  } else {
    report.push({ shot: 'reef-wall', error: 'no grouper resident found' });
  }
}

// 4. Offshore — pelagic roamers only (no residents offshore away from a Hump); give the roaming
// layer time to top up (manageRoamers tops up gradually, SPAWN_THROTTLE_S cadence) before judging,
// then aim at whichever roamer actually ended up nearby rather than a fixed heading — these are
// sparse, moving schools in a big volume, so a hardcoded look direction has decent odds of missing
// all of them. Prefer a bigger/more-legible species (dolphin pod, tuna) over e.g. flyingfish (len
// 0.32 m — easy to spawn nearby and still be nearly invisible in a screenshot).
{
  await teleportAndSettle(page, OFFSHORE_ORIGIN.x, OFFSHORE_ORIGIN.z, 5000);
  const schools = await activeSchools(page);
  const preferred = ['dolphin', 'yellowfin', 'bluefin', 'blackfin', 'amberjack', 'mahi', 'sailfish', 'wahoo'];
  let target = null;
  for (const p of preferred) { target = schools.find((s) => s.type === p); if (target) break; }
  if (!target) target = schools[0] ?? null;
  if (target) {
    const col = await page.evaluate(({ x, z }) => window.__fishDebug.waterColumnAt(x, z, performance.now() / 1000), { x: target.cx, z: target.cz });
    // Near-surface, not mid-column: offshore water is 45m+ deep, and the pelagics worth
    // photographing (dolphin/tuna/mahi/flyingfish) all swim at `level: 'surface'`, close to
    // `col.surf` — a mid-column debug-camera height here is 20+ m of open blue away from them.
    const eyeY = col.surf - 0.8, standoff = 22;
    await page.evaluate(({ cx, cz, y, tx, tz }) => {
      window.__fishDebugCamera = { x: cx, y, z: cz, lookX: tx, lookY: y, lookZ: tz };
    }, { cx: target.cx + standoff, cz: target.cz, y: eyeY, tx: target.cx, tz: target.cz });
    await page.waitForTimeout(1400);
  }
  await page.screenshot({ path: path.join(OUT, '04-offshore.png') });
  const pools = await poolStats(page), prof = await readProfilerStats(page);
  report.push({ shot: 'offshore', at: target ?? OFFSHORE_ORIGIN, targetType: target?.type ?? null, ...summarizeFishLoad(schools, pools), profiler: prof });
}

// 4b (bonus). The Humps — structure concentrating fish well offshore (ZONE_LIFE.Humps).
{
  const hit = await findSpecies(page, 'amberjack', REEF_ORIGIN.x, REEF_ORIGIN.z, 2200);
  if (hit) {
    await lookAtFromBoatSide(page, hit.x, hit.z, 10, 0.4, REEF_ORIGIN.x, REEF_ORIGIN.z);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, '04b-humps.png') });
    const schools = await activeSchools(page), pools = await poolStats(page), prof = await readProfilerStats(page);
    report.push({ shot: 'humps', at: hit, ...summarizeFishLoad(schools, pools), profiler: prof });
  } else {
    report.push({ shot: 'humps', error: 'no amberjack Hump resident found within search radius' });
  }
}

// 5. Surface shot from the helm — NO debug camera override, this is the real boat/chase camera,
// showing whatever topside life (rays, tarpon rolling, dolphin, baitfish) is near the boat. Finds a
// real dolphin-pod or tarpon resident/roamer first (guaranteed valid open water, see
// findResidentNear's doc comment), then points the *boat's heading* at it — stepSchool's own
// forward-vector convention is atan2(-dx,-dz) (behavior.ts/school.ts), so teleport's optional `h`
// uses the same formula to actually frame the animal instead of leaving it behind/beside the boat.
{
  let hit = await findSpecies(page, 'dolphin', HAWK_ORIGIN.x, HAWK_ORIGIN.z, 3000);
  if (!hit) hit = await findSpecies(page, 'tarpon', HAWK_ORIGIN.x, HAWK_ORIGIN.z, 3000);
  if (!hit) hit = await findSpecies(page, 'stingray', FLATS_ORIGIN.x, FLATS_ORIGIN.z, 3000);
  const target = hit || HAWK_ORIGIN;
  const standoff = 28;
  const originX = target.x + standoff, originZ = target.z;
  const heading = Math.atan2(-(target.x - originX), -(target.z - originZ));
  await page.evaluate(() => { delete window.__fishDebugCamera; });
  await page.evaluate(({ x, z, h }) => window.__fishDebug.teleport(x, z, h), { x: originX, z: originZ, h: heading });
  await page.waitForTimeout(3500); // long enough to catch a porpoise/roll act mid-cycle
  await page.screenshot({ path: path.join(OUT, '05-surface-from-helm.png') });
  const schools = await activeSchools(page), pools = await poolStats(page), prof = await readProfilerStats(page);
  report.push({ shot: 'surface-from-helm', at: target, ...summarizeFishLoad(schools, pools), profiler: prof });
}

console.log(JSON.stringify(report, null, 2));
console.log('console errors:', consoleErrors);
await browser.close();
console.log('done');
