/**
 * Before/after verification screenshots for the reef-realism pass (apps/client/src/world/reef/**)
 * — driven through the REAL shipped game (real diver entity, real underwater fog-override,
 * real lighting), not the isolated reef-harness.ts verification harness. That distinction matters:
 * the harness uses its own flat THREE.Fog and a bright directional sun with no per-channel
 * extinction, which is not what the game actually shows a diver — see this task's brief
 * ("Judge colour in the game at depth, not in isolation").
 *
 * Usage: node test/capture-reef-realism.mjs <before|after>
 *   -> screenshots/reef-realism/<before|after>/*.png
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || 'http://localhost:5173';
const TAG = process.argv[2] || 'after';
const OUT = path.join(HERE, 'screenshots', 'reef-realism', TAG);
fs.mkdirSync(OUT, { recursive: true });

// [label, depth(m), x, z, yaw(rad), pitch(rad)] — eye/look computed from REAL placed reef
// instances (apps/client/test/_scratch-find-near.test.ts, run once against placement.ts directly,
// not guessed): at x=200 the real bathymetry (depthAt) puts the crest's shallowest point at
// z~1460 (3.6 m), then drops in a near-cliff from ~1462 to ~1500 (3.7 m -> 12.1 m) — the "only
// 190 m wide, dropping 3.4 m -> 45.4 m" wall docs/ARCHITECTURE.md describes. z~1600 (the task's own
// suggested wall coordinate) is already ~34 m deep there (band 5, not the 11-15 m band-3/4 wall
// face) — so the 11-15 m shots below use z~1500-1514 instead, each framed a few metres from a real
// placed instance of the right species for that depth, camera pulled back/up and aimed at it
// (same framing technique as reef-harness.ts's buildWaypoints).
const SHOTS = [
  ['01-crest-4m', 1.70, 201.27, 1447.18, -2.356, -0.331], // near a placed staghorn, depth~3.9m
  ['02-midslope-7m', 5.87, 200.30, 1478.13, -2.356, -0.331], // near a placed brain coral, depth~7.7m
  ['03-wall-12m', 10.62, 200.74, 1499.62, -2.356, -0.331], // near a placed barrel sponge, depth~12.1m
  ['04-wall-15m', 13.28, 200.24, 1511.64, -2.356, -0.331], // near a placed star coral, depth~15.2m
  // Wider establishing shots at the task's own literal suggested coordinates, for context/honesty
  // about what a diver actually sees swimming through rather than only the close framed shots.
  ['05-crest-4m-wide', 4, 200, 1450, 0, -0.15],
  ['06-midslope-7m-wide', 7, 200, 1480, 0, -0.15],
];

async function setTier(page, tierLabel) {
  let label = await page.textContent('#btnQuality');
  for (let i = 0; i < 4 && !label.includes(tierLabel); i++) {
    await page.keyboard.press('KeyG');
    await page.waitForTimeout(300);
    label = await page.textContent('#btnQuality');
  }
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  // The login gate (ui/auth/gate.ts) renders over the start screen and swallows pointer events,
  // so #btnGo is unclickable until it is dismissed — "Play offline" needs no network.
  const offline = await page.$('button:has-text("Play offline")');
  if (offline) { await offline.click(); await page.waitForTimeout(1200); }
  await setTier(page, 'High');
  await page.click('#btnGo');
  await page.waitForTimeout(800);

  const hasHook = await page.evaluate(() => typeof window.__diverDebug?.enterAt === 'function');
  if (!hasHook) {
    console.error('__diverDebug not found on window — is this build up to date?');
    process.exitCode = 1;
  } else {
    const report = {};
    for (const [label, depth, x, z, yaw, pitch] of SHOTS) {
      await page.evaluate(([d, px, pz]) => window.__diverDebug.enterAt(d, px, pz), [depth, x, z]);
      await page.evaluate(([y, p]) => window.__diverDebug.setLook(y, p), [yaw, pitch]);
      // Software-WebGL sandbox renders at a few fps; give the chunk rebuild + several frames of
      // the current-driven sway/fog time to settle before capturing.
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(OUT, `${label}.png`) });
      console.log(`[reef-realism/${TAG}] ${label}: depth=${depth} x=${x} z=${z}`);
    }

    // Draw-call / triangle budget, whole scene, at a representative mid-depth reef shot.
    await page.evaluate(() => window.__diverDebug.enterAt(7, 200, 1480));
    await page.evaluate(() => window.__diverDebug.setLook(0, -0.15));
    await page.waitForTimeout(1200);
    await page.keyboard.press('KeyP'); // profiler HUD on
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, '07-profiler.png') });
    const profilerStats = await page.evaluate(() => document.getElementById('profilerHud')?.textContent ?? null);
    report.profiler = profilerStats;
    console.log(`[reef-realism/${TAG}] profiler:`, profilerStats);

    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log('page errors:', errs);
} finally {
  await browser.close();
}
console.log('done');
