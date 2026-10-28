/**
 * Screenshots of handgun mode - the pistol in hand, the muzzle flash, the locked-back slide, a
 * reload mid-way, a stunned fish floating, and a gull taking a hit. Look at the images; the
 * assertions live in capture-handgun.mjs.
 *
 * The muzzle flash lasts ~60 ms of SIMULATED time, which at this sandbox's ~3 fps / 0.05 s clamp is
 * a single rendered frame that a screenshot never lands on, so `holdFlash` (a debug hook on the
 * view model) freezes it for the capture. Feathers and splashes are particles with real lifetimes
 * of a second or two of sim time; the script waits on game state for them, not on wall time.
 *
 * Usage: CLIENT_URL=http://localhost:5231 node test/capture-handgun-views.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_URL } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || CLIENT_URL;
const OUT = path.join(HERE, 'screenshots', 'handgun');
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(120000);
const rawClick = (sel) => page.evaluate((s) => { document.querySelector(s)?.click(); }, sel);
const H = (fn, ...a) => page.evaluate(([f, args]) => window.__handgunDebug[f](...args), [fn, a]);
const S = () => H('state');
async function until(pred, what, ms = 120000) {
  const t0 = Date.now();
  for (;;) { if (await pred()) return; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what); await page.waitForTimeout(150); }
}
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(800);
if (await page.locator('.krAuthOffline').count()) { await rawClick('.krAuthOffline'); await page.waitForTimeout(200); }
await rawClick('#btnGo');
await page.waitForTimeout(2500);
await H('draw');
await until(async () => { const s = await S(); return s.mode === 'gun' && s.mag === 12 && !s.reloading; }, 'a loaded pistol');
await H('setRounds', 120);
await H('setLook', 0.3, 0.02);
await page.waitForTimeout(800);
await shot('01-gun-ready');

await H('holdFlash', true);
await H('fire');
await page.waitForTimeout(500);
await shot('02-muzzle-flash');
await H('holdFlash', false);

// empty it, slide locked
for (let i = 0; i < 11; i++) { await until(async () => (await S()).heat < 0.9, 'heat'); await until(async () => { await H('fire'); return (await S()).mag === 10 - i; }, 'shot', 30000); }
await until(async () => (await S()).flights === 0, 'bullets to land');
await page.waitForTimeout(600);
await shot('03-empty-slide-locked');
await H('fire');
await until(async () => (await S()).reloading, 'reload to start');
await until(async () => { const s = await S(); return s.reloading && s.reloadT < 1.3; }, 'mid reload');
await shot('04-reload-mid');
await until(async () => { const s = await S(); return !s.reloading && s.mag > 0; }, 'reload done');

// a stunned fish: a big visible one, aimed down at the water just off the hull, wait for the splash to clear
await H('setLook', 1.0, -0.35);
await H('clearSynth');
const f = await H('synth', 'fish', 3.2, 'mahi');
await H('aimAt', f.x, f.y, f.z);
await until(async () => { const s = await S(); return s.heat < 0.2 && !s.reloading && s.mag > 0; }, 'ready');
await H('fire');
await until(async () => (await S()).tally.fish >= 1, 'a hit');
await until(async () => (await S()).flights === 0, 'bullet to land');
await H('aimAt', f.x, f.y + 0.1, f.z);
await page.waitForTimeout(6000);
await shot('05-stunned-fish');
await H('clearSynth');

// a gull taking a hit: feathers
await H('setLook', 0.3, 0.3);
const b = await H('synth', 'bird', 9);
await H('aimAt', b.x, b.y, b.z);
await until(async () => { const s = await S(); return s.heat < 0.2 && !s.reloading && s.mag > 0; }, 'ready');
await H('holdFlash', true);
await H('fire');
await until(async () => (await S()).tally.birds >= 1, 'a bird hit');
await page.waitForTimeout(700);
await shot('06-gull-hit');
await H('holdFlash', false);
await H('clearSynth');
console.log('done', JSON.stringify((await S()).tally));
await browser.close();
