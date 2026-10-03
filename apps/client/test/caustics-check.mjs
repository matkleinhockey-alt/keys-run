import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5174';
const OUT = path.join(HERE, 'screenshots', 'dive');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(600);
// High tier for god rays + the budget check.
let label = await page.textContent('#btnQuality');
for (let i = 0; i < 4 && !label.includes('High'); i++) {
  await page.keyboard.press('KeyG');
  await page.waitForTimeout(300);
  label = await page.textContent('#btnQuality');
}
await page.click('#btnGo');
await page.waitForTimeout(800);

// Exact working framing from the coordinator's own capture: camera just above the crest seabed
// (~3.4 m deep there), looking down-and-along it. Boat position doesn't matter for this shot —
// __fishDebugCamera places the camera directly.
await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: 60, z: 1460 });
await page.waitForTimeout(500);
await page.evaluate(() => {
  window.__fishDebugCamera = { x: 60, y: -1.2, z: 1460, lookX: 68, lookY: -3.4, lookZ: 1472 };
});
await page.keyboard.press('KeyP');
await page.waitForTimeout(600);

await page.screenshot({ path: path.join(OUT, 'caustics-A-t0.png') });
const statsA = await page.evaluate(() => document.getElementById('profilerHud').textContent);

// Two more frames, 400ms apart (several rendered frames at this sandbox's rate), to see if the
// caustics pattern (time-animated) visibly changes — a static screenshot alone can't distinguish
// "no caustics" from "caustics present but frozen in this one frame".
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(OUT, 'caustics-B-t400ms.png') });
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, 'caustics-C-t1200ms.png') });

console.log('profiler at caustics check:', statsA);
console.log('done');
await browser.close();
