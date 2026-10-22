/**
 * End-to-end check of the two spearfishing input fixes, driven through REAL pointer/keyboard
 * events (not the __spearDebug.fire() shortcut, which bypasses exactly the code under test):
 *
 *  1. look-drag vs fire-tap: a drag must turn the view and must NOT fire; a clean click must fire
 *     and must NOT turn the view; a jittery 3 px click still fires; a right-button press does
 *     neither.
 *  2. reload is an act: after a shot the gun does not reload by itself (draw stays 0 with the hand
 *     off), holding R advances the draw after the brace phase, and the gun is only loaded once the
 *     draw completes. Screenshots at brace / mid-draw / loaded.
 *
 * Usage: CLIENT_URL=http://localhost:5192 node test/verify-spear-input.mjs <out-subdir>
 * This sandbox renders ~3 fps and the sim clamps to 0.05 s per frame, so reload waits are polled.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || 'http://localhost:5191';
const OUT = path.join(HERE, 'screenshots', 'spear-input', process.argv[2] || 'latest');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const rawClick = (sel) => page.evaluate((s) => { document.querySelector(s)?.click(); }, sel);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`); };

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(600);
if (await page.locator('.krAuthOffline').count()) { await rawClick('.krAuthOffline'); await page.waitForTimeout(200); }
await rawClick('#btnGo');
await page.waitForTimeout(600);
await rawClick('#btnDive');
await page.waitForTimeout(300);
await page.evaluate(() => window.__diverDebug.enterAt(3, 0, 1480.8, 0));
await page.waitForTimeout(800);

const aim = () => page.evaluate(() => window.__spearDebug.aimDir());
const loaded = () => page.evaluate(() => window.__spearDebug.reloadState().loaded);
const reload = () => page.evaluate(() => window.__spearDebug.reloadState());
const load = () => page.evaluate(() => { window.__spearDebug.reset(); window.__spearDebug.forceReloadReady(); });
// aimDir refreshes inside the fixed-step loop, so give it a couple of (slow) frames to settle
const settle = () => page.waitForTimeout(1500);
const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))) * 180 / Math.PI;

await load();
await page.mouse.move(640, 400);
await settle();

// ---- 1a. a look-drag turns the view and does not fire --------------------------------------
const a0 = await aim();
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(640 + i * 12, 400 + i * 2);
await page.mouse.up();
await settle();
const a1 = await aim();
check('drag turns the view', ang(a0, a1) > 3, `${ang(a0, a1).toFixed(1)} deg`);
check('drag does NOT fire the gun', await loaded(), 'gun still loaded');
await page.screenshot({ path: `${OUT}/01-after-drag.png` });

// ---- 1b. a drag that ends back where it started is still a look, not a tap ---------------
await page.mouse.move(640, 400);
await page.mouse.down();
await page.mouse.move(700, 400, { steps: 4 });
await page.mouse.move(640, 400, { steps: 4 });
await page.mouse.up();
await settle();
check('out-and-back drag does NOT fire', await loaded());

// ---- 1c. a clean click fires and does not turn the view ----------------------------------
const b0 = await aim();
await page.mouse.move(640, 400);
await page.mouse.down();
await page.mouse.up();
await settle();
const b1 = await aim();
check('clean click fires the gun', !(await loaded()), JSON.stringify(await reload()));
check('clean click does not turn the view', ang(b0, b1) < 0.5, `${ang(b0, b1).toFixed(2)} deg`);

// ---- 1d. a jittery click (3 px) still fires and does not turn the view -------------------
await load();
await settle();
const c0 = await aim();
await page.mouse.move(640, 400);
await page.mouse.down();
await page.mouse.move(642, 401);
await page.mouse.move(641, 402);
await page.mouse.up();
await settle();
const c1 = await aim();
check('3 px jitter click fires', !(await loaded()));
check('3 px jitter click does not turn the view', ang(c0, c1) < 0.5, `${ang(c0, c1).toFixed(2)} deg`);

// ---- 1e. right button does neither -------------------------------------------------------
await load();
await settle();
const d0 = await aim();
await page.mouse.move(640, 400);
await page.mouse.down({ button: 'right' });
await page.mouse.move(760, 430, { steps: 6 });
await page.mouse.up({ button: 'right' });
await settle();
check('right-button drag neither fires nor looks', (await loaded()) && ang(d0, await aim()) < 0.5);

// ---- 2. reload is an act ------------------------------------------------------------------
await load();
await settle();
await page.mouse.move(640, 400);
await page.mouse.down(); await page.mouse.up();
await settle();
const afterShot = await reload();
check('gun is empty after the shot', !afterShot.loaded && afterShot.draw === 0, JSON.stringify(afterShot));
await page.screenshot({ path: `${OUT}/02-brace.png` });

// hand OFF the bands: it must never reload on its own
await page.waitForTimeout(25000);
const idle = await reload();
check('with hands off the bands the gun does NOT reload by itself', !idle.loaded && idle.draw === 0, JSON.stringify(idle));

// hand ON: R held
await page.keyboard.down('KeyR');
let mid = null, snaps = 0;
const t0 = Date.now();
const samples = [];
while (Date.now() - t0 < 150000) {
  await page.waitForTimeout(2500);
  const s = await reload();
  samples.push({ t: +((Date.now() - t0) / 1000).toFixed(1), draw: +s.draw.toFixed(3), loaded: s.loaded });
  if (!mid && s.draw > 0.3 && s.draw < 0.9) { mid = s; await page.screenshot({ path: `${OUT}/03-mid-draw.png` }); }
  if (s.loaded) break;
}
await page.keyboard.up('KeyR');
console.log('draw samples (real s, draw):', JSON.stringify(samples));
check('holding R draws the bands to loaded', (await reload()).loaded, '');
check('a mid-draw state was observed (not an instant load)', !!mid, JSON.stringify(mid));
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/04-loaded.png` });

console.log('page errors:', errs);
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} FAILED` : 'ALL PASSED');
process.exit(failed.length ? 1 : 0);
