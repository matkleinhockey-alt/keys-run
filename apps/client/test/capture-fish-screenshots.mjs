/**
 * Fish verification screenshots (task brief "Verify" section): a dense reef school, a lone
 * barracuda, a ray on the flats, and fish fleeing a diver. Saved to test/screenshots/fish/.
 *
 * Uses the `window.__fishDebug` dev-only hook (game/world.ts) to find a deterministic resident of
 * a given species near a search origin, instead of guessing world coordinates blind — see that
 * hook's comment for why this needs no actual gameplay backdoor (spawning is a pure function of
 * world position).
 *
 * The chase/helm camera rig has no underwater mode yet (entities/diver/** doesn't exist in this
 * branch), so merely teleporting the boat leaves the camera above the water surface looking down
 * — the fish are several metres below and invisible. `window.__fishDebugCamera` (also game/
 * world.ts, also dev-only) places the THREE.PerspectiveCamera directly; `__fishDebug.waterColumnAt`
 * gives the floor/surface world-Y at a point so the camera lands inside the water column instead
 * of guessing a world Y blind.
 *
 * This sandbox renders on a software/virtualised GPU — generous waits, no fps claims.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5191';
const OUT = path.join(HERE, 'screenshots', 'fish');
fs.mkdirSync(OUT, { recursive: true });

/** Places the boat `BOAT_OFFSET` m from the target and a standalone camera `standoff` m from it,
 * both along the line from the target back toward `origin` (the search origin passed to
 * `findSpecies`, always a stable open-water reference point) — so both sit on the open-water side
 * of the target instead of a random direction that might cross the shoreline. `residentsForChunk`
 * only keeps a school's own *anchor* off the beach (`shoreInfo(x,z).d >= 4`, spawn.ts); a random
 * direction `standoff` away from that anchor has no such guarantee, which is what produced a
 * camera stuck in the sand on an early pass over this file. Putting the boat *farther* out along
 * the same line keeps it directly behind the camera (out of frame) instead of needing a second,
 * independently-safe direction. Eye and look-at both use the *target's* water column for their Y
 * (not the camera's own position's column) so a local depth gradient near the target — the reef
 * wall drops 3.4 m -> 45.4 m over 190 m — can't tilt the shot; levelT (0 = floor, 1 = surface)
 * picks how high in that column to shoot from. */
const BOAT_OFFSET = 60;
async function lookAt(page, targetX, targetZ, standoff, levelT, origin, eyeLevelT = levelT) {
  const dx = origin.x - targetX, dz = origin.z - targetZ;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;

  await page.evaluate(({ bx, bz }) => window.__fishDebug.teleport(bx, bz), {
    bx: targetX + ux * BOAT_OFFSET, bz: targetZ + uz * BOAT_OFFSET,
  });
  await page.waitForTimeout(1200); // let resident/roamer activation settle at the new boat position

  const tgtCol = await page.evaluate(({ targetX, targetZ }) => window.__fishDebug.waterColumnAt(targetX, targetZ, performance.now() / 1000), { targetX, targetZ });
  const lookY = tgtCol.floor + (tgtCol.surf - tgtCol.floor) * levelT;
  const eyeY = tgtCol.floor + (tgtCol.surf - tgtCol.floor) * eyeLevelT;
  const cx = targetX + ux * standoff, cz = targetZ + uz * standoff;
  await page.evaluate(({ cx, cz, eyeY, targetX, targetZ, lookY }) => {
    window.__fishDebugCamera = { x: cx, y: eyeY, z: cz, lookX: targetX, lookY, lookZ: targetZ };
  }, { cx, cz, eyeY, targetX, targetZ, lookY });
  await page.waitForTimeout(600);
  return { cx, cz, eyeY };
}

async function findSpecies(page, type, originX, originZ, radius) {
  return page.evaluate(({ type, originX, originZ, radius }) => window.__fishDebug.findResidentNear(type, originX, originZ, radius), { type, originX, originZ, radius });
}

async function readProfiler(page) {
  return page.evaluate(() => {
    const el = document.getElementById('profilerHud');
    return el ? el.textContent : null;
  });
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

// Reef wall sits at dz 1460-1650 (docs/ARCHITECTURE.md "the money location"); x=0 keeps the
// search origin away from any island.
const REEF_ORIGIN = { x: 0, z: 1550 };
const FLATS_ORIGIN = { x: -1150, z: 320 }; // near spawn, searched wide since Flats is depth-gated, not location-gated

// 1. Dense reef school (yellowtail: school size 8-14, Reef-only in ZONE_LIFE, level='mid')
{
  const hit = await findSpecies(page, 'yellowtail', REEF_ORIGIN.x, REEF_ORIGIN.z, 1200);
  if (hit) {
    await lookAt(page, hit.x, hit.z, 5.5, 0.5, REEF_ORIGIN);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, '01-dense-reef-school.png') });
    console.log('dense reef school: yellowtail at', hit, 'profiler:', await readProfiler(page));
  } else {
    console.log('dense reef school: no yellowtail resident found within search radius');
  }
}

// 2. Lone barracuda (school size 1-1, appears in Flats/Hawk Channel/Reef, level='surface')
{
  let origin = REEF_ORIGIN;
  let hit = await findSpecies(page, 'barracuda', REEF_ORIGIN.x, REEF_ORIGIN.z, 2000);
  if (!hit) { hit = await findSpecies(page, 'barracuda', FLATS_ORIGIN.x, FLATS_ORIGIN.z, 2000); origin = FLATS_ORIGIN; }
  if (hit) {
    await lookAt(page, hit.x, hit.z, 5, 0.75, origin);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, '02-lone-barracuda.png') });
    console.log('lone barracuda at', hit);
  } else {
    console.log('lone barracuda: none found within search radius');
  }
}

// 3. Ray on the flats (stingray: Flats-only in ZONE_LIFE, gated on depth < 2.6 m, level='bottom')
{
  const hit = await findSpecies(page, 'stingray', FLATS_ORIGIN.x, FLATS_ORIGIN.z, 2500);
  if (hit) {
    // Rays are flat, bottom-hugging animals — a near-floor, near-horizontal eye line sees only
    // their edge-on sliver. Shoot from higher in the column, angled down, for the classic
    // "diamond gliding over sand" view that actually reads as a ray.
    await lookAt(page, hit.x, hit.z, 3, 0.12, FLATS_ORIGIN, 0.4);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, '03-ray-on-flats.png') });
    console.log('ray on the flats at', hit);
  } else {
    console.log('ray on the flats: no stingray resident found within search radius');
  }
}

// 4. Fish fleeing a diver — injects a synthetic diver threat via the dev-only
// window.__fishDebugDiver hook (game/world.ts) next to a skittish schooling species, since
// entities/diver/** doesn't exist yet in this branch (a different agent's work this phase).
{
  let origin = REEF_ORIGIN;
  let hit = await findSpecies(page, 'mangrove', REEF_ORIGIN.x, REEF_ORIGIN.z, 2000);
  if (!hit) { hit = await findSpecies(page, 'mangrove', FLATS_ORIGIN.x, FLATS_ORIGIN.z, 2000); origin = FLATS_ORIGIN; }
  if (hit) {
    await lookAt(page, hit.x, hit.z, 8, 0.5, origin);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT, '04a-before-diver.png') });
    await page.evaluate(({ x, z }) => { window.__fishDebugDiver = { x, z }; }, { x: hit.x, z: hit.z });
    await page.waitForTimeout(2200); // enough sim time for fleeParamsFor('skittish').speedMul=3.2 to read as a clear bolt
    await page.screenshot({ path: path.join(OUT, '04b-fleeing-diver.png') });
    console.log('mangrove snapper school at', hit);
  } else {
    console.log('fleeing diver: no mangrove resident found within search radius');
  }
}

console.log('console errors:', consoleErrors);
await browser.close();
console.log('done');
