/**
 * Verification screenshots + profiler numbers for the chunked LOD seafloor (feat/seafloor):
 * the reef wall from above water, the flats, and the deep edge beyond the wall. Saved to
 * apps/client/test/screenshots/seafloor/.
 *
 * This sandboxed environment renders on software WebGL (SwiftShader), so fps is meaningless and
 * real elapsed time per rendered frame can be large — the fixed-timestep physics accumulator
 * (game/world.ts `frame()`) clamps each frame to at most 50 ms of simulated time, so a slow
 * render means the *simulated* boat trip also takes a while in wall-clock terms. Every wait below
 * polls an actual HUD condition (never a fixed sleep for navigation) with a generous timeout
 * instead of assuming a frame rate.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5190';
const OUT = path.join(HERE, 'screenshots', 'seafloor');
fs.mkdirSync(OUT, { recursive: true });

async function waitUntil(page, fn, { timeout = 240000, interval = 500, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await page.waitForTimeout(interval);
  }
  console.log(`[timeout] ${label} after ${timeout}ms`);
  return false;
}

async function gaugeText(page, id) {
  return (await page.textContent('#' + id).catch(() => '')) || '';
}
async function depthFt(page) {
  const t = await gaugeText(page, 'gDep');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : NaN;
}
async function headingDeg(page) {
  const t = await gaugeText(page, 'gHdg');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : NaN;
}

/** Shows the profiler HUD (P), reads its text back, hides it again. */
async function readProfiler(page) {
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(700); // profiler DOM throttles to every 200ms; give it a couple ticks
  const txt = await page.textContent('#profilerHud').catch(() => '');
  await page.keyboard.press('KeyP');
  return txt;
}

async function shoot(page, name, note) {
  const profilerTxt = await readProfiler(page);
  console.log(`\n=== ${name} ===`);
  if (note) console.log(note);
  console.log(profilerTxt.replace(/\n/g, ' | '));
  // Leave the HUD visible in the saved screenshot so the numbers travel with the image.
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, name) });
  await page.keyboard.press('KeyP');
  return profilerTxt;
}

async function turnToward(page, targetDeg, { holdMs = 3000 } = {}) {
  // input.left -> steer=+1 -> heading h increases -> displayed gHdg (= -h mod 360) decreases.
  // So to make gHdg decrease toward targetDeg from above, hold 'left' (KeyA); to increase it
  // toward targetDeg from below, hold 'right' (KeyD). One coarse turn, then small corrections.
  const cur = await headingDeg(page);
  const diff = ((targetDeg - cur + 540) % 360) - 180; // signed shortest diff, (-180,180]
  const key = diff < 0 ? 'KeyA' : 'KeyD'; // need gHdg to decrease -> left; increase -> right
  await page.keyboard.down(key);
  await page.waitForTimeout(holdMs);
  await page.keyboard.up(key);
  // small corrections
  for (let i = 0; i < 6; i++) {
    const h = await headingDeg(page);
    let d = ((targetDeg - h + 540) % 360) - 180;
    if (Math.abs(d) < 12) break;
    const k = d < 0 ? 'KeyA' : 'KeyD';
    await page.keyboard.down(k);
    await page.waitForTimeout(250);
    await page.keyboard.up(k);
    await page.waitForTimeout(150);
  }
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.click('#btnGo');
  await page.waitForTimeout(600);

  // ---- 1. Flats: head toward the nearest shoreline at low throttle until depth reads shallow
  // (zoneAt's Flats threshold is d < 2.6 m =~ 8.5 ft) — this is a short hop from spawn (Boot Key
  // Harbor), unlike the reef wall leg below.
  await page.keyboard.down('KeyW');
  await turnToward(page, 0, { holdMs: 1500 }); // try heading toward the harbor shoreline
  await waitUntil(page, async () => {
    const ft = await depthFt(page);
    return Number.isFinite(ft) && ft < 9;
  }, { timeout: 60000, label: 'flats depth' });
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(500);
  await shoot(page, '01-flats.png', 'Shallow flats (d < ~2.6 m) near spawn.');

  // ---- 2. Reef wall: spawn dz~305 -> reef wall corridor is dz 1460-1650 (docs/ARCHITECTURE.md),
  // a ~1.2 km trip. Target heading ~180 (gHdg) points roughly toward increasing dz regardless of
  // x (chainZ's x-dependence is small next to this distance). Poll depth/zone, not a fixed wait.
  await page.keyboard.down('KeyW');
  await turnToward(page, 180, { holdMs: 3000 });
  await waitUntil(page, async () => {
    const zone = await gaugeText(page, 'gZone');
    return zone.includes('Sombrero Reef');
  }, { timeout: 420000, label: 'reach Sombrero Reef zone' });
  // Now on the crest/approach — keep going a bit further to get onto the actual wall drop
  // (crest ~3.4 m -> base ~45.4 m): wait for depth to start climbing hard.
  await waitUntil(page, async () => {
    const ft = await depthFt(page);
    return Number.isFinite(ft) && ft > 60; // well down the wall face
  }, { timeout: 180000, label: 'descend the reef wall' });
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(500);
  await shoot(page, '02-reef-wall.png', 'On/just past the reef wall drop (dz ~1460-1650).');

  // ---- 3. Deep edge: continue a bit further until past the wall base into the Gulf Stream side.
  await page.keyboard.down('KeyW');
  await waitUntil(page, async () => {
    const ft = await depthFt(page);
    return Number.isFinite(ft) && ft > 140; // past the ~45.4 m wall base
  }, { timeout: 180000, label: 'reach deep edge' });
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(500);
  await shoot(page, '03-deep-edge.png', 'Past the wall base, deep Gulf Stream side.');

  console.log('\nerrors seen:', errs);
} finally {
  await browser.close();
}
console.log('done');
