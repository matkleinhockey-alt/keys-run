/**
 * Shop panel + gear screen, in the real game, by Playwright.
 * Usage: CLIENT_URL=http://localhost:5199 node test/capture-shop.mjs
 * Drives the real F key and real buy-button clicks; only the cash comes from `window.__shopDebug`.
 * ~3 fps software GPU: every wait is generous, no frame-rate claims. Saves to test/screenshots/shop/.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5199';
const OUT = path.join(HERE, 'screenshots', 'shop');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
const SX = -900, SZ = 250.7;

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
page.setDefaultTimeout(180000);
page.on('pageerror', (e) => errs.push('pageerror: ' + e));
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
await page.goto(URL, { waitUntil: 'load' });
await sleep(800);
await page.evaluate(() => { try { localStorage.clear(); } catch { /* */ } });
await page.reload({ waitUntil: 'load' });
await sleep(800);
const offline = await page.$('.krAuthOffline');
if (offline) await offline.click();
await sleep(500);
await page.click('#btnGo');
await sleep(1500);

const shot = async (name) => {
  for (let i = 0; i < 3; i++) {
    try { await page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 120000 }); console.log('shot', name); return; } catch { await sleep(3000); }
  }
  errs.push('no shot ' + name);
};
const ev = (fn, arg) => page.evaluate(fn, arg);

// step ashore
await ev(({ x, z }) => window.__fishDebug.teleport(x, z, Math.PI), { x: SX, z: SZ + 55 });
await sleep(2500);
await page.keyboard.press('KeyF');
await sleep(2500);
console.log('mode', await ev(() => window.__landDebug.mode()));

async function openVenue(door) {
  const at = await ev((id) => window.__landDebug.interactWorld(id), door);
  await ev(({ x, z }) => { window.__landDebug.place(x, z, 0); window.__landDebug.look(0, -0.05); }, { x: at[0], z: at[1] });
  await sleep(3000);
  await page.keyboard.press('KeyF');
  await sleep(2000);
}

// 1. broke: refusal
await openVenue('door-guns');
await shot('01-guns-broke');
await page.click('button.buy[data-item]');
await sleep(500);
console.log('refusal:', await ev(() => document.getElementById('shopMsg').textContent));
await shot('02-guns-refused');
await page.keyboard.press('Escape'); await sleep(800);

// 2. rich: buy a gear item (real click), then the same again
console.log('grant', await ev(() => window.__shopDebug.grant(3000)));
await openVenue('door-guns');
const firstId = await ev(() => document.querySelector('button.buy[data-item]').dataset.item);
await page.click(`button.buy[data-item="${firstId}"]`);
await sleep(500);
console.log('bought:', await ev(() => document.getElementById('shopMsg').textContent));
await page.click(`button.buy[data-item="${firstId}"]`, { force: true }).catch(() => {});
console.log('again (button disabled):', await ev((id) => document.querySelector(`button.buy[data-item="${id}"]`).disabled, firstId));
await shot('03-guns-bought');
await page.keyboard.press('Escape'); await sleep(800);

// 3. dive shop + diner for the gear screen
await openVenue('door-dive');
for (const id of await ev(() => [...document.querySelectorAll('button.buy:not([disabled])')].map((b) => b.dataset.item))) {
  await page.click(`button.buy[data-item="${id}"]`, { noWaitAfter: true, timeout: 120000 }); await sleep(1500);
}
await shot('04-dive-bought');
await page.keyboard.press('Escape'); await sleep(800);
console.log('buy coffee via hook', JSON.stringify(await ev(() => window.__shopDebug.ids())));
await ev(() => { const s = window.__shopDebug; s.grant(500); return [s.buy('coffee'), s.buy('bait-shrimp'), s.buy('shot-key-lime')]; }).then((r) => console.log(JSON.stringify(r)));
await ev(() => window.__shopDebug.advance(5));

// 4. gear screen (Tab)
await page.keyboard.press('Tab');
await sleep(1500);
await shot('05-gear');
console.log('modifiers', JSON.stringify(await ev(() => window.__shopDebug.modifiers())));
await page.keyboard.press('Tab'); await sleep(500);

// 5. persistence + expiry
const before = await ev(() => JSON.stringify(window.__shopDebug.state().inventory));
await page.reload({ waitUntil: 'load' });
await sleep(1500);
const o2 = await page.$('.krAuthOffline'); if (o2) await o2.click();
await sleep(500); await page.click('#btnGo'); await sleep(1500);
const after = await ev(() => JSON.stringify(window.__shopDebug.state().inventory));
console.log('persisted across reload:', before === after, '\n', after);
await ev(() => window.__shopDebug.advance(1000));
console.log('after +1000s buffs:', await ev(() => JSON.stringify(window.__shopDebug.state().inventory.buffs)));

console.log('errors:', errs.length ? errs : 'none');
await browser.close();
