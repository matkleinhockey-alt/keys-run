/**
 * What a seaway costs you: the same throttle, into the sea and away from it.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { CLIENT_URL } from './server.mjs';
const OUT = 'test/screenshots/seakeeping'; fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.setDefaultTimeout(120000);
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(CLIENT_URL, { waitUntil: 'load' }); await p.waitForTimeout(800);
const off = await p.$('button:has-text("Play offline")'); if (off) { await off.click(); await p.waitForTimeout(900); }
await p.waitForTimeout(3500); await p.click('#btnGo'); await p.waitForTimeout(2000);
// Big swell: the default is Choppy, and the sea states cycle Calm/Choppy/Haulover/Big swell.
for (let i = 0; i < 2; i++) { await p.click('#btnSea'); await p.waitForTimeout(900); }
await p.waitForTimeout(6000);                        // the sea state ramps in
const chainZ = (x) => 0.000012 * x * x;

for (const [tag, hdgDeg] of [['following', 0], ['head', 180]]) {
  await p.evaluate(({ x, z, h }) => window.__fishDebug.teleport(x, z, h),
    { x: 0, z: chainZ(0) + 2600, h: hdgDeg * Math.PI / 180 });
  await p.waitForTimeout(3000);
  await p.keyboard.down('KeyW');
  await p.waitForTimeout(40000);                      // get up to whatever the sea allows
  let kn = 0, pMin = 9, pMax = -9, n = 0, sw = 0, vy = 0;
  for (let i = 0; i < 40; i++) {
    const s = await p.evaluate(() => window.__fishDebug.boatState());
    kn += s.speed; pMin = Math.min(pMin, s.pitch); pMax = Math.max(pMax, s.pitch); sw += s.seaWork; vy += Math.abs(s.vy); n++;
    await p.waitForTimeout(250);
  }
  await p.screenshot({ path: `${OUT}/${tag}.png` });
  await p.keyboard.up('KeyW');
  const hud = await p.evaluate(() => document.getElementById('gSpd')?.textContent);
  console.log(`${tag.padEnd(10)} HUD ${String(hud).padStart(3)} kn   mean ${(kn / n / 1.35 / 0.5144).toFixed(1)} kn   pitch ${((pMax - pMin) * 180 / Math.PI).toFixed(1)} deg   seaWork ${(sw / n).toFixed(2)}   |vy| ${(vy / n).toFixed(2)}`);
  await p.waitForTimeout(3000);
}
console.log('errs', errs.slice(0, 2));
await b.close();
