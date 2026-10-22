/**
 * Screenshots of the speargun view model through a hauled reload: ready, brace pose right after a
 * shot, mid-draw (glove on the band tail), and locked. Holds C (descend) so the diver stays at
 * working depth instead of floating up to the surface during the slow-sim waits.
 * Usage: CLIENT_URL=http://localhost:5192 node test/capture-reload-viewmodel.mjs <out-subdir>
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || 'http://localhost:5191';
const OUT = path.join(HERE, 'screenshots', 'reload-vm', process.argv[2] || 'latest');
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(60000);
const rawClick = (sel) => page.evaluate((s) => { document.querySelector(s)?.click(); }, sel);
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(600);
if (await page.locator('.krAuthOffline').count()) { await rawClick('.krAuthOffline'); await page.waitForTimeout(200); }
await rawClick('#btnGo');
await page.waitForTimeout(600);
await rawClick('#btnDive');
await page.waitForTimeout(300);
await page.evaluate(() => window.__diverDebug.enterAt(4, 0, 600, 0));
await page.keyboard.down('KeyC');
await page.waitForTimeout(1500);
await page.evaluate(() => { window.__spearDebug.reset(); window.__spearDebug.forceReloadReady(); });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/01-ready.png` });
await page.mouse.move(640, 400); await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${OUT}/02-brace.png` });
console.log('after shot', JSON.stringify(await page.evaluate(() => window.__spearDebug.reloadState())));
await page.keyboard.down('KeyR');
let shot = 0;
for (let i = 0; i < 80; i++) {
  await page.waitForTimeout(1500);
  const s = await page.evaluate(() => window.__spearDebug.reloadState());
  if (shot === 0 && s.recoverLeft === 0 && s.draw > 0.15) { await page.screenshot({ path: `${OUT}/03-draw-early.png` }); shot = 1; console.log('early', JSON.stringify(s)); }
  if (shot === 1 && s.draw > 0.6) { await page.screenshot({ path: `${OUT}/04-draw-late.png` }); shot = 2; console.log('late', JSON.stringify(s)); }
  if (s.loaded) break;
}
await page.keyboard.up('KeyR');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/05-loaded.png` });
console.log('final', JSON.stringify(await page.evaluate(() => window.__spearDebug.reloadState())), 'depth', await page.evaluate(() => document.querySelector('#diverHud')?.textContent));
await browser.close();
