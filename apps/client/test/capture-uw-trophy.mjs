/**
 * Verification screenshots for the underwater trophy card (game/catch/underwater-trophy.ts).
 * Uses `window.__catchPortraitDebug.landSpeared` to land a given species instantly and step the
 * render loop directly — same fast-iteration trick capture-catch-portrait.mjs uses for the
 * surface card, for the same reason (playing out a real spearfishing catch at this sandbox's
 * ~2-4 fps software-WebGL rate is impractical to iterate against).
 *
 * Usage: node test/capture-uw-trophy.mjs <out-subdir>
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || 'http://localhost:5199';
const TAG = process.argv[2] || 'latest';
const OUT = path.join(HERE, 'screenshots', 'harpoon', TAG);
fs.mkdirSync(OUT, { recursive: true });

const SPECIES = [
  ['mutton', 'mutton', 7],
  ['mahi', 'mahi', 20],
  ['hogfish', 'hogfish', 5],
  ['tarpon', 'tarpon', 60],
  ['yellowtail', 'yellowtail', 2],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

// This sandbox runs several agents' dev servers/browsers concurrently (CPU-contended, software
// WebGL) — `locator().screenshot()`'s "wait until the element's layout is stable across frames"
// polling can time out under that contention even though nothing is actually wrong. A plain
// `page.screenshot({clip})` from a once-measured bounding box sidesteps that retry loop entirely.
async function shootElement(selector, outPath) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no bounding box (not visible?)`);
  await page.screenshot({ path: outPath, clip: box });
}
/** Same contention-avoidance idea as shootElement: a raw DOM `.click()` skips Playwright's
 * hover/visibility/actionability polling, which is what was timing out under this sandbox's CPU
 * contention — not anything wrong with the page. */
async function rawClick(selector) {
  await page.evaluate((sel) => { document.querySelector(sel)?.click(); }, selector);
}

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(600);
// feat/net-client's auth gate (ui/auth/gate.ts) now sits in front of the start screen — "Play
// offline" is the single-player path this script (and the game generally) still needs to work
// without a server.
if (await page.locator('.krAuthOffline').count()) { await rawClick('.krAuthOffline'); await page.waitForTimeout(200); }
await rawClick('#btnGo');
await page.waitForTimeout(600);

const hasHook = await page.evaluate(() => typeof window.__catchPortraitDebug?.landSpeared === 'function');
if (!hasHook) {
  console.error('__catchPortraitDebug.landSpeared not found on window — is this build up to date?');
  await browser.close();
  process.exit(1);
}

for (const [label, key, weight] of SPECIES) {
  await page.evaluate(({ key, weight }) => window.__catchPortraitDebug.landSpeared(key, weight), { key, weight });
  await page.waitForTimeout(80);
  await page.evaluate((t) => window.__catchPortraitDebug.renderFrame(t), 0.6);
  await page.waitForTimeout(80);
  await shootElement('#card .catch', `${OUT}/${label}-card.png`);
  await shootElement('#fishCanvas', `${OUT}/${label}-canvas.png`);
  if (process.env.DEBUG_LOG) {
    const log1 = await page.evaluate(() => window.__uwTrophyDebugLog);
    const log2 = await page.evaluate(() => window.__uwTrophyDebugLog2);
    console.log(`[uw-trophy] ${label}`, JSON.stringify(log1), JSON.stringify(log2));
  } else {
    console.log(`[uw-trophy] ${label} captured`);
  }
}

console.log('page errors:', errs);
await browser.close();
