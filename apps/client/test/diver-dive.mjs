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

async function textString(page, selector) {
  return (await page.textContent(selector).catch(() => '')) ?? '';
}

async function blackoutOpacity(page) {
  return page.evaluate(() => {
    const el = document.getElementById('blackout');
    return el ? parseFloat(getComputedStyle(el).opacity) : 0;
  });
}

/**
 * This machine runs this test's browser alongside several other agents' own concurrent
 * Playwright/Chromium sessions (parallel feature work on sibling worktrees). entities/boat/
 * input.ts resets every held key on the window's `blur` event (so a real player's stuck key
 * doesn't drive the boat forever after alt-tabbing) — if another session's window steals OS
 * focus mid-wait, that fires here too and silently drops our held throttle/turn keys. Bringing
 * this page back to front and re-asserting the held keys every poll tick is cheap, idempotent
 * (a repeat keydown is a no-op for entities/boat/input.ts's boolean button state), and closes
 * that window without needing to detect it after the fact.
 */
async function reassertFocus(page, heldKeys = []) {
  await page.bringToFront().catch(() => {});
  for (const code of heldKeys) await page.keyboard.down(code).catch(() => {});
}

async function pollUntil(label, fn, { timeoutMs = 60000, intervalMs = 250, heldKeys = [] } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    await reassertFocus(page, heldKeys);
    last = await fn();
    if (last.done) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${label} (last=${JSON.stringify(last)})`);
}

/**
 * Drives straight (whatever heading/throttle keys are currently held) for approximately
 * `meters`, integrating distance from the #gSpd knots readout rather than a guessed hold
 * duration — robust to boat accel/top-speed tuning changes. Bails immediately (rather than
 * waiting out a timeout) if the HUD's own aground warning (#gWarn, ui/hud.ts) fires, which is
 * exactly the failure this replaces: driving blind into Boot Key's shoreline. Re-asserts
 * `heldKeys` every tick — see reassertFocus's header for why that matters on this machine.
 */
async function driveStraightFor(page, meters, { timeoutMs = 180000, intervalMs = 250, heldKeys = ['KeyW'] } = {}) {
  let dist = 0;
  const start = Date.now();
  while (dist < meters) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`driveStraightFor: only covered ${dist.toFixed(0)}m of ${meters}m in ${timeoutMs}ms`);
    }
    await reassertFocus(page, heldKeys);
    const warn = await textString(page, '#gWarn');
    if (warn.includes('Aground')) {
      throw new Error(`driveStraightFor: ran aground after ${dist.toFixed(0)}m of ${meters}m (gWarn="${warn}")`);
    }
    const knots = await textNumber(page, '#gSpd');
    await page.waitForTimeout(intervalMs);
    const mps = (Number.isFinite(knots) ? knots : 0) * 0.5144;
    dist += mps * (intervalMs / 1000);
  }
  return dist;
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

  // --- Navigate to real deep water near the reef wall ---------------------------------------
  // Spawn (SPAWN_X=-1150, dz=305, state/constants.ts) sits in Boot Key Harbor with Boot Key
  // (packages/shared/src/world/chain.ts ISL_DEF: centre x=-1050, dz=560, semi-axes a=620/b=170,
  // i.e. its shoreline spans world x in roughly [-1670,-430] through the harbor-exit dz band)
  // directly south. Driving due south from spawn — this test's first version did exactly that —
  // runs the boat straight onto that beach (confirmed with packages/shared's own landH/depthAt:
  // landH > 0 for dz in ~[425,705] at x=-1150, depth clamped to 0.35 m). Route east past the
  // island's east edge first, *then* turn south into Hawk Channel and down the reef wall
  // (dz 1460-1650, depthAt(dz>=~1580) >= 30 m — see docs/ARCHITECTURE.md's depth-band table).
  //
  // There's no x/z HUD readout to steer by, so the east leg is driven for a target distance
  // integrated from the #gSpd knots readout (driveStraightFor above) rather than a guessed hold
  // duration — 950 m clears the island's east edge (-430) with >500 m of margin even accounting
  // for acceleration ramp-up, verified by walking packages/shared's depthAt/landH along the
  // planned route (x=-350..-250 stays clear, landH<=-2, all the way to the reef wall).
  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyA'); // left = decreasing compass heading, see entities/boat/input.ts's KEYMAP
  await pollUntil('heading ~90 (east)', async () => {
    const hdg = await textNumber(page, '#gHdg');
    return { done: hdg > 70 && hdg < 110, hdg };
  }, { timeoutMs: 40000, heldKeys: ['KeyW', 'KeyA'] });
  await page.keyboard.up('KeyA');
  await page.screenshot({ path: `${OUT}/02-underway-east.png` });

  await driveStraightFor(page, 950);
  await page.screenshot({ path: `${OUT}/03-cleared-boot-key.png` });

  await page.keyboard.down('KeyD'); // right = increasing compass heading: 90 -> 180
  await pollUntil('heading ~180 (south)', async () => {
    const hdg = await textNumber(page, '#gHdg');
    return { done: hdg > 150 && hdg < 210, hdg };
  }, { timeoutMs: 40000, heldKeys: ['KeyW', 'KeyD'] });
  await page.keyboard.up('KeyD');
  await page.screenshot({ path: `${OUT}/04-underway-south.png` });

  // #gDep is boat depth in feet (existing boat HUD, see ui/hud.ts) — wait for well past 20 m
  // (65.6 ft) so the dive spot has real margin, matching the reef-wall depths the doc describes.
  await pollUntil('boat depth > 100 ft (~30 m)', async () => {
    const ft = await textNumber(page, '#gDep');
    return { done: ft > 100, ft };
  }, { timeoutMs: 180000, heldKeys: ['KeyW'] });
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/05-over-deep-water.png` });

  // --- Jump overboard and descend ------------------------------------------------------------
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/06-overboard.png` });

  // Hold descend for the rest of the dive. Positive buoyancy 0-10 m means a sustained kick is
  // needed to get past it; past neutral depth (~11 m) buoyancy flips negative and freefall takes
  // over, so this single held key both gets the dive going and keeps air burning fast afterward.
  await page.keyboard.down('KeyC');

  await pollUntil('depth >= 20 m', async () => {
    const depth = await textNumber(page, '#diveDepth');
    return { done: depth >= 20, depth };
  }, { timeoutMs: 45000, heldKeys: ['KeyC'] });
  await page.screenshot({ path: `${OUT}/07-depth-20m.png` });

  // --- Run the air out and black out ---------------------------------------------------------
  await pollUntil('air critical', async () => {
    const pct = await textNumber(page, '#airPct');
    return { done: pct <= 15, pct };
  }, { timeoutMs: 60000, heldKeys: ['KeyC'] });
  await page.screenshot({ path: `${OUT}/08-air-critical.png` });

  await pollUntil('blackout vignette fully opaque', async () => {
    const op = await blackoutOpacity(page);
    return { done: op >= 0.99, op };
  }, { timeoutMs: 20000 });
  await page.screenshot({ path: `${OUT}/09-blackout.png` });

  // --- Wake on the boat ------------------------------------------------------------------------
  await pollUntil('woke back on the boat (boat HUD visible again)', async () => {
    const hidden = await page.evaluate(() => document.getElementById('gauges')?.classList.contains('hidden') ?? true);
    return { done: !hidden };
  }, { timeoutMs: 15000 });
  await page.keyboard.up('KeyC');
  await page.waitForTimeout(1000); // let the vignette's CSS fade-out (style.css #blackout, .8s) finish
  await page.screenshot({ path: `${OUT}/10-woke-on-boat.png` });

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
