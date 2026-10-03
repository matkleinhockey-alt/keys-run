/**
 * Fish verification screenshots (task brief "Verify" section): a dense reef school, a lone
 * barracuda, a ray on the flats, and fish fleeing a diver. Saved to test/screenshots/fish/.
 *
 * Uses the `window.__fishDebug` dev-only hook (game/world.ts) to find a deterministic resident
 * of a given species near a search origin and teleport the boat there, instead of guessing world
 * coordinates blind — see that hook's comment for why this needs no actual gameplay backdoor
 * (spawning is a pure function of world position).
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

function faceToward(boatX, boatZ, targetX, targetZ) {
  return Math.atan2(-(targetX - boatX), -(targetZ - boatZ));
}

async function placeAt(page, targetX, targetZ, standoff = 14) {
  const angle = Math.random() * Math.PI * 2;
  const bx = targetX + Math.sin(angle) * standoff;
  const bz = targetZ + Math.cos(angle) * standoff;
  const h = faceToward(bx, bz, targetX, targetZ);
  await page.evaluate(({ bx, bz, h }) => window.__fishDebug.teleport(bx, bz, h), { bx, bz, h });
  return { bx, bz, h };
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

// 1. Dense reef school (yellowtail: school size 8-14, Reef-only in ZONE_LIFE)
{
  const hit = await findSpecies(page, 'yellowtail', REEF_ORIGIN.x, REEF_ORIGIN.z, 1200);
  if (hit) {
    await placeAt(page, hit.x, hit.z, 11);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, '01-dense-reef-school.png') });
    console.log('dense reef school: yellowtail at', hit, 'profiler:', await readProfiler(page));
  } else {
    console.log('dense reef school: no yellowtail resident found within search radius');
  }
}

// 2. Lone barracuda (school size 1-1, appears in Flats/Hawk Channel/Reef)
{
  const hit = await findSpecies(page, 'barracuda', REEF_ORIGIN.x, REEF_ORIGIN.z, 2000)
    ?? await findSpecies(page, 'barracuda', FLATS_ORIGIN.x, FLATS_ORIGIN.z, 2000);
  if (hit) {
    await placeAt(page, hit.x, hit.z, 9);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, '02-lone-barracuda.png') });
    console.log('lone barracuda at', hit);
  } else {
    console.log('lone barracuda: none found within search radius');
  }
}

// 3. Ray on the flats (stingray: Flats-only in ZONE_LIFE, gated on depth < 2.6 m, not location)
{
  const hit = await findSpecies(page, 'stingray', FLATS_ORIGIN.x, FLATS_ORIGIN.z, 2500);
  if (hit) {
    await placeAt(page, hit.x, hit.z, 7);
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
  const hit = await findSpecies(page, 'mangrove', REEF_ORIGIN.x, REEF_ORIGIN.z, 2000)
    ?? await findSpecies(page, 'mangrove', FLATS_ORIGIN.x, FLATS_ORIGIN.z, 2000);
  if (hit) {
    const placed = await placeAt(page, hit.x, hit.z, 16);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT, '04a-before-diver.png') });
    await page.evaluate(({ x, z }) => { window.__fishDebugDiver = { x, z }; }, { x: hit.x, z: hit.z });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, '04b-fleeing-diver.png') });
    console.log('mangrove snapper school at', hit, 'boat at', placed);
  } else {
    console.log('fleeing diver: no mangrove resident found within search radius');
  }
}

console.log('console errors:', consoleErrors);
await browser.close();
console.log('done');
