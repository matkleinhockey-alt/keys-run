/**
 * Verification screenshots for the catch-card portrait realism pass (game/catch/portrait.ts).
 * Uses `window.__catchPortraitDebug` (that file's / catch-flow.ts's doc comments) to land a
 * given species instantly and step the portrait's own render loop directly, instead of playing
 * out a real cast -> fight -> land, which this sandbox's software-WebGL renderer makes take
 * several real minutes per fish (see capture-fishing.mjs's header for the measured slowdown).
 *
 * Usage: node test/capture-catch-portrait.mjs <out-subdir>
 *   e.g. `node test/capture-catch-portrait.mjs after` -> screenshots/catch-portrait/after/*.png
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || 'http://localhost:5173';
const TAG = process.argv[2] || 'after';
const OUT = path.join(HERE, 'screenshots', 'catch-portrait', TAG);
fs.mkdirSync(OUT, { recursive: true });

// name, species key, a mid-range weight (lb), covering a big pelagic, a reef fish and an
// odd-shaped/elongated species per the task brief.
const SPECIES = [
  ['mahi', 'mahi', 25],
  ['tarpon', 'tarpon', 80],
  ['yellowtail', 'yellowtail', 3],
  ['hogfish', 'hogfish', 8],
  ['barracuda', 'barracuda', 20],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(600);
await page.click('#btnGo');
await page.waitForTimeout(600);

const hasHook = await page.evaluate(() => typeof window.__catchPortraitDebug?.land === 'function');
if (!hasHook) {
  console.error('__catchPortraitDebug not found on window — is this build up to date?');
  await browser.close();
  process.exit(1);
}

const timings = [];
for (const [label, key, weight] of SPECIES) {
  await page.evaluate(({ key, weight }) => window.__catchPortraitDebug.land(key, weight), { key, weight });
  await page.waitForTimeout(80);
  const ms = await page.evaluate((t) => {
    const start = performance.now();
    window.__catchPortraitDebug.renderFrame(t);
    return performance.now() - start;
  }, 0.55);
  timings.push([label, ms]);
  await page.waitForTimeout(80);
  await page.locator('#card .catch').screenshot({ path: `${OUT}/${label}-card.png` });
  await page.locator('#fishCanvas').screenshot({ path: `${OUT}/${label}-canvas.png` });
  console.log(`[catch-portrait] ${label}: renderFrame ${ms.toFixed(2)} ms (software WebGL — not representative of real GPU fps)`);
}

console.log('--- render cost (ms per renderFrame call, includes the CPU tonemap/encode pass) ---');
for (const [label, ms] of timings) console.log(`  ${label}: ${ms.toFixed(2)} ms`);
console.log('page errors:', errs);

await browser.close();
