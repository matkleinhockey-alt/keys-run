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
for (let i = 0; i < 12; i++) {
  const o = await p.$('button:has-text("Play offline")');
  if (o) { await o.click().catch(() => {}); await p.waitForTimeout(900); }
  if (!(await p.$('.krAuthGate'))) break;
  await p.waitForTimeout(1000);
}
await p.waitForTimeout(3500);
await p.click('#btnGo', { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(2000);

// Nothing solid, and nothing moored, may stand in the fairway.
{
  const HALF = 45, R0 = 66, R1 = 190;
  const inCh = (x, z) => Math.abs(x - SX) < HALF && ((z - SZ) * SDIR) > R0 && ((z - SZ) * SDIR) < R1;
  const rects = await p.evaluate(() => window.__fishDebug.dockRects());
  const piles = await p.evaluate(() => window.__fishDebug.pilings());
  const boats = await p.evaluate(() => window.__fishDebug.marinaBoats());
  const nr = rects.filter((r) => inCh((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2) || inCh(r.x0, r.z0) || inCh(r.x1, r.z1)).length;
  console.log(`in the fairway — dock rects ${nr}/${rects.length}, pilings ${piles.filter((q) => inCh(q.x, q.z)).length}/${piles.length}, moored hulls ${boats.filter((q) => inCh(q.x, q.z)).length}/${boats.length}`);
}

// Sit out in the approach looking down the channel at the dock.
for (const r of [200, 140, 100, 60, 20]) {
  await p.evaluate(({ x, z, h }) => window.__fishDebug.teleport(x, z, h),
    { x: SX, z: SZ + SDIR * r, h: SDIR > 0 ? 0 : Math.PI });   // face the dock, not the sea
  await p.waitForTimeout(r === 200 ? 14000 : 4500);
  const s = await p.evaluate(() => window.__fishDebug.boatState());
  const d = await p.evaluate(() => document.getElementById('gDep')?.textContent);
  const warn = await p.evaluate(() => document.getElementById('gWarn')?.textContent);
  console.log(`${String(r).padStart(3)} m off the dock: depth ${d}  ${warn ? '>> ' + warn : 'clear'}  (boat ${s.x.toFixed(0)},${s.z.toFixed(0)})`);
  await p.screenshot({ path: `${OUT}/r${r}.png` });
}
console.log('errs', errs.slice(0, 2));
await b.close();
