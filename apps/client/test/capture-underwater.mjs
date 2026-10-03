/**
 * Verification screenshots for the underwater render stack (apps/client/src/world/underwater/**,
 * water.ts's Snell's-window branch, fog-override.ts's global extinction). No diver entity exists
 * yet, so this drives the camera via the temporary `window.__uwDebug` hook (world/underwater/
 * index.ts) rather than real gameplay input.
 *
 * Coordinates for the depth shots were picked by binary-searching the real, shared `depthAt(x,z)`
 * (see packages/shared/src/world/depth.ts) at x=0 for each target depth, so the camera lands at a
 * genuine real-world depth rather than an arbitrary y value with no matching seafloor.
 *
 * Saved to apps/client/test/screenshots/underwater/.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5180';
const OUT = path.join(HERE, 'screenshots', 'underwater');
fs.mkdirSync(OUT, { recursive: true });

// [label, depth(m), x, z, pitch(rad, +up), yaw(rad)]
const DEPTH_SHOTS = [
  ['01-depth-02m', 2, 0, 280.0],
  ['02-depth-08m', 8, 0, 1480.8],
  ['03-depth-15m', 15, 0, 1512.5],
  ['04-depth-25m', 25, 0, 1557.7],
];

async function setTier(page, tierLabel) {
  let label = await page.textContent('#btnQuality');
  for (let i = 0; i < 4 && !label.includes(tierLabel); i++) {
    await page.keyboard.press('KeyG');
    await page.waitForTimeout(300);
    label = await page.textContent('#btnQuality');
  }
}

async function dive(page, depth, x, z, pitch = 0, yaw = 0, instant = true) {
  // `instant`: snap the surface-crossing tween (fog blend/FOV/sky-hide) straight to its converged
  // state instead of trusting a fixed waitForTimeout to let it tween in — see transition.ts's
  // `snap()` doc comment. This sandboxed Playwright environment renders at ~1-2 fps (software
  // WebGL), so "900ms of wall-clock time" is an unreliable proxy for "enough simulated frames for
  // a ~0.1s real-time tween to converge", and a steady-state depth shot doesn't want to be testing
  // that tween anyway — only the surface-crossing shot below passes instant=false on purpose, since
  // catching that tween mid-flight is the entire point of that one.
  await page.evaluate(([d, px, pz, pp, py, inst]) => {
    window.__uwDebug.set(d, { x: px, z: pz, pitch: pp, yaw: py, instant: inst });
  }, [depth, x, z, pitch, yaw, instant]);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(600);
await setTier(page, 'High'); // god rays are High+ only — verify them, not just the low bar
await page.click('#btnGo');
await page.waitForTimeout(500);

for (const [label, depth, x, z] of DEPTH_SHOTS) {
  // -0.3 rad: steep enough that the (out-of-scope, documented-hazard) seafloor mesh — where one
  // still exists at this depth, see world/underwater/index.ts's seafloorHeightAt — actually fills
  // part of the frame instead of sitting entirely below a near-horizontal sightline; still reads
  // as "swimming", not straight down.
  await dive(page, depth, x, z, -0.3, 0);
  await page.waitForTimeout(900); // let the surface-crossing tween settle and marine snow populate
  await page.screenshot({ path: `${OUT}/${label}.png` });
}

// Snell's window: shallow, looking steeply up so both the window's centre and its critical-angle
// rim land inside the frame. fov 58deg narrows to exactly 43.5deg underwater (instant:true snaps
// this immediately rather than leaving it to tween, see dive() above) -> 21.75deg half-angle;
// pitch 0.99 rad (56.75deg off horizontal, i.e. 33.25deg off vertical) puts the far edge of frame
// at 33.25+21.75 = 55deg off vertical — past the ~48.75deg critical angle, so the dark
// total-internal-reflection band is visible past the window's rim, not just the bright window
// itself (an earlier version of this shot used 1.15 rad, sized for an *unconverged* ~58deg FOV —
// once the FOV genuinely narrows, that framing put the whole frame inside the window with no rim
// visible at all, a regression caught when fixing the FOV-convergence bug, not an unrelated one).
await dive(page, 5, 0, 1480.8, 0.99, 0);
await page.waitForTimeout(900);
await page.screenshot({ path: `${OUT}/05-snells-window.png` });

// Surface-crossing moment: start just above (instant, so the "above water" state itself is settled
// before the crossing starts), then cross to just below *without* snapping, so the FOV/fog/
// lens-wetting tweens are genuinely mid-flight (their time constant is ~0.12-0.45s) when captured.
await dive(page, -1.2, 0, 1480.8, -0.05, 0, true);
await page.waitForTimeout(500);
await dive(page, 0.35, 0, 1480.8, -0.05, 0, false);
await page.waitForTimeout(150);
await page.screenshot({ path: `${OUT}/06-surface-crossing.png` });

// One topside baseline for comparison/context (not one of the required shots, but cheap and useful
// for an honest side-by-side judgement of the above/below fog degrade).
await page.evaluate(() => window.__uwDebug.clear());
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/00-topside-baseline.png` });

// Draw-call / triangle budget: sample the profiler HUD's own numbers (docs/ARCHITECTURE.md
// "< 300 draw calls underwater") at a representative mid-depth shot, HUD toggled visible.
await dive(page, 12, 0, 1500, -0.08, 0);
await page.waitForTimeout(900);
await page.keyboard.press('KeyP'); // toggle profiler HUD on
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/07-profiler-underwater.png` });
const profilerStats = await page.evaluate(() => {
  const el = document.getElementById('profilerHud');
  return el ? el.textContent : null;
});

console.log('profiler (underwater, mid-depth):', profilerStats);
console.log('console/page errors:', errs);
await browser.close();
