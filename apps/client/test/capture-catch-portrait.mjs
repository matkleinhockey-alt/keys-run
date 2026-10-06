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
// 'captain' rather than the old 'catch-portrait' name — the catch-flow/captain-grip-and-grin task
// renamed this script's output directory to match where it asked for verification screenshots.
const OUT = path.join(HERE, 'screenshots', 'captain', TAG);
fs.mkdirSync(OUT, { recursive: true });

// name, species key, a mid-range weight (lb), covering a big pelagic, a reef fish and an
// odd-shaped/elongated species per the task brief. `grouper` added for the fish-geometry task's
// "rounded tail" case (apps/client/src/entities/fish/fins.ts's buildTail 'round' style).
// `mutton` and `marlin` added for the captain-grip-and-grin task: a full small -> huge range
// (yellowtail ~3 lb through a ~600 lb marlin) to prove both the captain-holds-it path and the
// hang-rig fallback above portrait.ts's `HOLDABLE_MAX_LEN_M` threshold.
const SPECIES = [
  ['yellowtail', 'yellowtail', 3],
  ['mutton', 'mutton', 7],
  ['hogfish', 'hogfish', 8],
  ['barracuda', 'barracuda', 20],
  ['mahi', 'mahi', 25],
  ['grouper', 'grouper', 25],
  ['tarpon', 'tarpon', 80],
  ['marlin', 'marlin', 600],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

// This sandbox runs several agents' dev servers/browsers concurrently (CPU-contended, software
// WebGL) — `locator().screenshot()`'s "wait until the element's layout is stable across frames"
// polling can time out under that contention even though nothing is actually wrong
// (capture-uw-trophy.mjs hit the same thing first). A plain `page.screenshot({clip})` from a
// once-measured bounding box sidesteps that retry loop entirely.
async function shootElement(selector, outPath) {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no bounding box (not visible?)`);
  await page.screenshot({ path: outPath, clip: box });
}

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(600);
// The login gate (ui/auth/gate.ts) renders over the start screen and swallows pointer events, so
// `#btnGo` is unclickable until it is dismissed. "Play offline" is the no-account path and needs
// no network, which is what a screenshot run wants anyway.
const offline = await page.$('button:has-text("Play offline")');
if (offline) { await offline.click(); await page.waitForTimeout(1200); }
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
  await shootElement('#card .catch', `${OUT}/${label}-card.png`);
  await shootElement('#fishCanvas', `${OUT}/${label}-canvas.png`);
  console.log(`[catch-portrait] ${label}: renderFrame ${ms.toFixed(2)} ms (software WebGL — not representative of real GPU fps)`);
}

console.log('--- render cost (ms per renderFrame call, includes the CPU tonemap/encode pass) ---');
for (const [label, ms] of timings) console.log(`  ${label}: ${ms.toFixed(2)} ms`);
console.log('page errors:', errs);

await browser.close();
