/**
 * The dredged entrance to the town marina: drive in from the harbour approach.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { CLIENT_URL } from './server.mjs';
import { SX, SZ, SDIR } from './marina.mjs';
const OUT = 'test/screenshots/marina-approach'; fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.setDefaultTimeout(120000);
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(CLIENT_URL, { waitUntil: 'load' }); await p.waitForTimeout(800);
const off = await p.$('button:has-text("Play offline")'); if (off) { await off.click(); await p.waitForTimeout(900); }
await p.waitForTimeout(3500); await p.click('#btnGo'); await p.waitForTimeout(2000);

// Sit out in the approach looking down the channel at the dock.
const look = Math.atan2(0, SDIR);   // dock lies back along -dir
for (const r of [200, 140, 100, 60, 20]) {
  await p.evaluate(({ x, z, h }) => window.__fishDebug.teleport(x, z, h),
    { x: SX, z: SZ + SDIR * r, h: SDIR > 0 ? Math.PI : 0 });
  await p.waitForTimeout(r === 200 ? 14000 : 4500);
  const s = await p.evaluate(() => window.__fishDebug.boatState());
  const d = await p.evaluate(() => document.getElementById('gDep')?.textContent);
  const warn = await p.evaluate(() => document.getElementById('gWarn')?.textContent);
  console.log(`${String(r).padStart(3)} m off the dock: depth ${d}  ${warn ? '>> ' + warn : 'clear'}  (boat ${s.x.toFixed(0)},${s.z.toFixed(0)})`);
  await p.screenshot({ path: `${OUT}/r${r}.png` });
}
void look;
console.log('errs', errs.slice(0, 2));
await b.close();
