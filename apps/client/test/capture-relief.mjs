/**
 * Screenshots of the seafloor relief from a diver's eye: reef-front spur-and-groove, a rock
 * outcrop / coral head field, the wall terraces, and (control) open Hawk Channel sand.
 * Also prints, for each station, the diver's floor height under them from the SAME function the
 * mesh uses, and the ground-collision result after letting the diver settle — so a diver standing
 * on a rock is a number, not an impression.
 * Usage: CLIENT_URL=http://localhost:5192 node test/capture-relief.mjs <out-subdir>
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_URL } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || CLIENT_URL;
const OUT = path.join(HERE, 'screenshots', 'relief', process.argv[2] || 'latest');
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(90000);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
const rawClick = (sel) => page.evaluate((s) => { document.querySelector(s)?.click(); }, sel);
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(600);
if (await page.locator('.krAuthOffline').count()) { await rawClick('.krAuthOffline'); await page.waitForTimeout(200); }
await rawClick('#btnGo');
await page.waitForTimeout(600);
await rawClick('#btnDive');
await page.waitForTimeout(300);

// [name, x, z, depth-to-enter-at, yaw]; z already includes chainZ(x) (= 1.2e-5 x^2)
const chainZ = (x) => 0.000012 * x * x;
const stations = [
  // the tallest outcrop in the reef-front scan (3.4 m of relief), seen from 12 m off, looking at its top
  ['tallest-outcrop', -1353, 1412, 4, 0, [-1353, -3.4, 1399]],
  ['atop-outcrop', -1353, 1401, 2.5, 0, [-1353, -6, 1388]],
  ['beside-outcrop', -1353, 1384, 5.5, Math.PI, [-1353, -3.2, 1399]],
  ['second-outcrop', -981, 1356, 4, 0, [-981, -4, 1341]],
  ['spur-groove', -700, chainZ(-700) + 1385, 6, 0],
  ['outcrops', -1400, chainZ(-1400) + 1250, 7, 0.5],
  ['wall-terraces', -700, chainZ(-700) + 1540, 22, 0],
  ['control-sand', 200, chainZ(200) + 800, 5, 0],
];
for (const [name, x, z, depth, yaw, look] of stations) {
  await page.evaluate(([d, xx, zz, y]) => window.__diverDebug.enterAt(d, xx, zz, y), [depth, x, z, yaw]);
  await page.keyboard.down('KeyC'); // hold descend so the slow-sim wait doesn't float us up
  await page.waitForTimeout(9000);
  if (look) await page.evaluate(([a, b, c]) => window.__spearDebug.setLook(a, b, c), look);
  await page.waitForTimeout(1500);
  await page.keyboard.up('KeyC');
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(name, await page.evaluate(() => document.querySelector('#diverHud')?.textContent?.replace(/\s+/g, ' ').trim()));
}
console.log('page errors:', errs);
await browser.close();
