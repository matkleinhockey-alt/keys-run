/**
 * The town's services, in the real game, by Playwright (verification only).
 *
 * Usage:  CLIENT_URL=http://localhost:5191 node test/capture-services.mjs
 *
 * Drives `window.__servicesDebug.debugBuy(key)` (the shop UI's canBuy -> onPurchased flow minus the
 * wallet charge) and screenshots the motel fade, the cabaret vignettes and the scratch card into
 * test/screenshots/services/. ~3 fps software GPU: waits are generous, no fps claims.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5191';
const OUT = path.join(HERE, 'screenshots', 'services');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
page.on('pageerror', (e) => errs.push('pageerror: ' + e));
page.setDefaultTimeout(180000); // software GPU: give every action room
await page.goto(URL, { waitUntil: 'load' });
await sleep(800);
const offline = await page.$('.krAuthOffline');
if (offline) await offline.click();
await sleep(500);
await page.click('#btnGo');
await sleep(2000);

const shot = async (name) => { await page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 120000 }); console.log('shot', name); };
const buy = (key) => page.evaluate((k) => {
  const r = window.__servicesDebug.debugBuy(k);
  return { refused: r.refused, lines: r.outcome?.lines ?? null, payout: r.outcome?.payout ?? 0 };
}, key);
const tod = () => page.evaluate(() => ({ btn: document.getElementById('btnSun')?.textContent }));

await page.evaluate(() => window.__servicesDebug.debugHoldCards(true));
console.log('fuel', JSON.stringify(await buy('boat.fuel')));
console.log('tip before cover', JSON.stringify(await buy('club.tip')));
console.log('cover', JSON.stringify(await buy('club.cover')));
await sleep(3500); await shot('club-cover');
console.log('cover twice', JSON.stringify(await buy('club.cover')));
console.log('bottle', JSON.stringify(await buy('club.bottle')));
await sleep(3500); await shot('club-bottle');
console.log('tip', JSON.stringify(await buy('club.tip')));
await sleep(3500); await shot('club-tip');
await page.keyboard.press('Space');

for (let i = 0; i < 6; i++) {
  const r = await buy('liquor.scratch');
  console.log('scratch', i, JSON.stringify(r));
  if (i === 5) { await sleep(9000); await shot('scratch-win'); }
  if (i === 0) { await sleep(9000); await shot('scratch'); }
  await page.evaluate(() => document.getElementById('svcCard')?.click());
  await sleep(300);
}
console.log('sock', JSON.stringify(await buy('laundromat.sock')));
console.log('wash', JSON.stringify(await buy('laundromat.wash')));

const before = await tod();
console.log('motel', JSON.stringify(await buy('motel.night')), before);
console.log('motel again (mid-sleep)', JSON.stringify(await buy('motel.night')));
await page.waitForFunction(() => Number(document.getElementById('svcFade').style.opacity) > 0.4);
await shot('motel-fade-out');
await page.waitForFunction(() => document.getElementById('svcCard')?.textContent.includes('Room 7') && !document.getElementById('svcCard').classList.contains('hidden'));
await sleep(2500); await shot('motel-card');
await page.waitForFunction(() => !document.getElementById('svcFade').classList.contains('on'));
await shot('motel-after');
console.log('after', JSON.stringify(await tod()));
console.log('motel at sunset', JSON.stringify(await buy('motel.night')));
console.log('saved', await page.evaluate(() => localStorage.getItem('keysrun.services.v1')));
console.log(errs.length ? 'ERRORS ' + errs.join('\n') : 'no page errors');
await browser.close();
