#!/usr/bin/env node
/**
 * Playwright smoke test for the diver feature (apps/client/src/entities/diver/**): drives the
 * boat out to real deep water near the reef wall (docs/ARCHITECTURE.md: "the reef wall sits at
 * dz 1460-1650 ... dropping 3.4 m -> 45.4 m"), jumps overboard, descends to 20+ m, lets the
 * breath-hold run out, and watches the blackout -> wake-on-the-boat recovery play out.
 *
 * Follows this project's existing raw-chromium-script convention (see capture-screenshots.mjs,
 * visual-parity.mjs) rather than a test runner — same reasoning: this is meant to be looked at
 * (screenshots to ./screenshots/diver/), not pixel-diffed. Run with:
 *   node apps/client/test/diver-dive.mjs
 * against a running dev server (CLIENT_URL, default http://localhost:5173).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5173';
const OUT = path.join(HERE, 'screenshots', 'diver');
fs.mkdirSync(OUT, { recursive: true });

async function textNumber(page, selector) {
  const t = await page.textContent(selector).catch(() => null);
  if (!t) return NaN;
  const m = t.match(/-?[\d.]+/);
  return m ? parseFloat(m[0]) : NaN;
}

async function blackoutOpacity(page) {
  return page.evaluate(() => {
    const el = document.getElementById('blackout');
    return el ? parseFloat(getComputedStyle(el).opacity) : 0;
  });
}

async function pollUntil(label, fn, { timeoutMs = 60000, intervalMs = 250 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last.done) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${label} (last=${JSON.stringify(last)})`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

try {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/01-start.png` });

  await page.click('#btnGo');
  await page.waitForTimeout(500);
  await page.click('#wrap'); // ensure the canvas (not a HUD button) has focus for keyboard input

  // --- Navigate to real deep water near the reef wall --------------------------------------
  // Spawn heading is 90 degrees (facing -x); turning toward ~180 degrees points the boat at
  // +z, which is the direction depth increases along the reef wall at this x. Hold W+A (turn
  // while accelerating) until heading is close to 180, then release A and cruise straight.
  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyA');
  await pollUntil('heading ~180', async () => {
    const hdg = await textNumber(page, '#gHdg');
    return { done: hdg > 150 && hdg < 210, hdg };
  }, { timeoutMs: 40000 });
  await page.keyboard.up('KeyA');
  await page.screenshot({ path: `${OUT}/02-underway.png` });

  // #gDep is boat depth in feet (existing boat HUD, see ui/hud.ts) — wait for well past 20 m
  // (65.6 ft) so the dive spot has real margin, matching the reef-wall depths the doc describes.
  await pollUntil('boat depth > 100 ft (~30 m)', async () => {
    const ft = await textNumber(page, '#gDep');
    return { done: ft > 100, ft };
  }, { timeoutMs: 60000 });
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/03-over-deep-water.png` });

  // --- Jump overboard and descend ------------------------------------------------------------
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/04-overboard.png` });

  // Hold descend for the rest of the dive. Positive buoyancy 0-10 m means a sustained kick is
  // needed to get past it; past neutral depth (~11 m) buoyancy flips negative and freefall takes
  // over, so this single held key both gets the dive going and keeps air burning fast afterward.
  await page.keyboard.down('KeyC');

  await pollUntil('depth >= 20 m', async () => {
    const depth = await textNumber(page, '#diveDepth');
    return { done: depth >= 20, depth };
  }, { timeoutMs: 45000 });
  await page.screenshot({ path: `${OUT}/05-depth-20m.png` });

  // --- Run the air out and black out ---------------------------------------------------------
  await pollUntil('air critical', async () => {
    const pct = await textNumber(page, '#airPct');
    return { done: pct <= 15, pct };
  }, { timeoutMs: 60000 });
  await page.screenshot({ path: `${OUT}/06-air-critical.png` });

  await pollUntil('blackout vignette fully opaque', async () => {
    const op = await blackoutOpacity(page);
    return { done: op >= 0.99, op };
  }, { timeoutMs: 20000 });
  await page.screenshot({ path: `${OUT}/07-blackout.png` });

  // --- Wake on the boat ------------------------------------------------------------------------
  await pollUntil('woke back on the boat (boat HUD visible again)', async () => {
    const hidden = await page.evaluate(() => document.getElementById('gauges')?.classList.contains('hidden') ?? true);
    return { done: !hidden };
  }, { timeoutMs: 15000 });
  await page.keyboard.up('KeyC');
  await page.waitForTimeout(1000); // let the vignette's CSS fade-out (style.css #blackout, .8s) finish
  await page.screenshot({ path: `${OUT}/08-woke-on-boat.png` });

  console.log('diver-dive: all stages passed.');
  console.log('page errors seen:', pageErrors);
  if (pageErrors.length > 0) process.exitCode = 1;
} catch (err) {
  console.error('diver-dive FAILED:', err);
  await page.screenshot({ path: `${OUT}/FAILURE.png` }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
