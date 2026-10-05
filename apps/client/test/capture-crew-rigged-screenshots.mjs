/**
 * Verification screenshots for the realistic-crew-rigging feature (entities/crew-model/** now
 * pointed at the bikini_girl mesh bound to the Mixamo dance skeleton — see
 * packages/assets-pipeline/scripts/rig-dancer.blender.py and this task's report for the rigging
 * work itself; Blender's own render is the authoritative quality check, these are a supplementary
 * in-engine confirmation that the asset loads and animates through the real pipeline).
 *
 * Captures: a wide chase-cam shot for context, then several time-spaced frames from the close
 * helm view (closest built-in camera to a crew figure) to show the dance animation actually
 * advancing. Saved to apps/client/test/screenshots/crew-rigged/.
 *
 * This sandboxed environment renders very slowly (software/virtualized GPU, ~2-4fps) — waits are
 * generous and frames are spaced by real wall-clock time (the animation mixer runs off real dt,
 * not frame count, so even a handful of rendered frames several seconds apart show real motion).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5174';
const OUT = path.join(HERE, 'screenshots', 'crew-rigged');
fs.mkdirSync(OUT, { recursive: true });

async function currentTierLabel(page) {
  const hud = await page.textContent('#btnQuality').catch(() => '');
  if (hud && hud !== '⚙ —') return hud;
  return page.textContent('#btnQualityStart').catch(() => '');
}
async function setTier(page, tierLabel) {
  let label = await currentTierLabel(page);
  for (let i = 0; i < 4 && !label?.includes(tierLabel); i++) {
    await page.keyboard.press('KeyG');
    await page.waitForTimeout(300);
    label = await currentTierLabel(page);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(800);
await setTier(page, 'High');

// Default boat is BOATS[1] = Grady-White (2 crew slots per placements.ts). Give the crew asset
// plenty of time to fetch before boarding.
await page.waitForTimeout(6000);
await page.click('#btnGo');
await page.waitForTimeout(1500);

// Zoom the chase cam in as close as the control allows (scroll "up" = negative deltaY = zoom in,
// per entities/camera.ts's wheel handler; zoom clamps at 0.55).
for (let i = 0; i < 20; i++) {
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(30);
}
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/01-grady-chase-zoomed.png` });

// Drag-orbit to recentre on the crew figure (visible off-centre at max zoom — the helm-view
// first-person camera, tried first, faces forward over the bow and never sees the deck crew at
// all, which is the "can't frame the figures" problem this task's brief flagged).
await page.mouse.move(640, 400);
await page.mouse.down();
await page.mouse.move(520, 400, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/02-grady-chase-recentred.png` });

// Several time-spaced frames from this view to show the dance clip actually advancing.
for (let i = 0; i < 6; i++) {
  await page.screenshot({ path: `${OUT}/03-tick${i}.png` });
  await page.waitForTimeout(1200);
}

console.log('errors:', errs);
await page.close();
await browser.close();
console.log('done');
