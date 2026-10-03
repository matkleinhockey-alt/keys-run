import { chromium } from 'playwright';
import crypto from 'node:crypto';

const URL = process.env.CLIENT_URL || 'http://localhost:5174';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(600);
let label = await page.textContent('#btnQuality');
for (let i = 0; i < 4 && !label.includes('High'); i++) {
  await page.keyboard.press('KeyG');
  await page.waitForTimeout(300);
  label = await page.textContent('#btnQuality');
}
await page.click('#btnGo');
await page.waitForTimeout(800);

await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: 60, z: 1460 });
await page.waitForTimeout(500);
await page.evaluate(() => {
  window.__fishDebugCamera = { x: 60, y: -1.2, z: 1460, lookX: 68, lookY: -3.4, lookZ: 1472 };
});
await page.waitForTimeout(600);

// Crop a region that's clearly underwater and on/near the reef (per the earlier full-frame
// captures: y ~350-650 spans the coral). Sample several times over ~2s; hash each. If caustics
// (an animated, time-varying effect) are actually rendering, the pixels in this region should
// change frame to frame even though the camera is perfectly static. If every hash is identical,
// nothing in this region is animating.
const clip = { x: 300, y: 400, width: 500, height: 300 };
const hashes = [];
for (let i = 0; i < 6; i++) {
  const buf = await page.screenshot({ clip });
  const h = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  hashes.push(h);
  console.log(`sample ${i} t=${(i * 350)}ms hash=${h}`);
  await page.waitForTimeout(350);
}

const unique = new Set(hashes);
console.log(`unique hashes: ${unique.size} / ${hashes.length}`);
console.log(unique.size === 1 ? 'STATIC — nothing in this crop is animating' : 'CHANGING — something in this crop is animating frame to frame');

await browser.close();
