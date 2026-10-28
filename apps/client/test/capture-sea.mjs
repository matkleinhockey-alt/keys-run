/**
 * The sea, state by state: how the surface looks and how hard the hull works in each.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { CLIENT_URL } from './server.mjs';
const OUT = 'test/screenshots/sea'; fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.setDefaultTimeout(120000);
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(CLIENT_URL, { waitUntil: 'load' }); await p.waitForTimeout(800);
const off = await p.$('button:has-text("Play offline")'); if (off) { await off.click(); await p.waitForTimeout(900); }
await p.waitForTimeout(3500);
await p.click('#btnGo'); await p.waitForTimeout(2500);

// The Hawk Channel, which is where the game is actually played.
const chainZ = (x) => 0.000012 * x * x;
await p.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: 0, z: chainZ(0) + 900 });
await p.waitForTimeout(15000);

for (let i = 0; i < 4; i++) {
  // Indexed, not named off #btnSea: that label does not refresh on the HUD tick, so reading it
  // gave "choppy" four times and every shot overwrote the last one.
  const name = ['start', 'next-1', 'next-2', 'next-3'][i];
  // Let the sea-state ramp finish, then watch the hull work for ten seconds.
  await p.waitForTimeout(9000);
  let pMin = 9, pMax = -9, rMin = 9, rMax = -9, yMin = 9, yMax = -9;
  for (let k = 0; k < 60; k++) {
    const s = await p.evaluate(() => window.__fishDebug.boatState());
    pMin = Math.min(pMin, s.pitch); pMax = Math.max(pMax, s.pitch);
    rMin = Math.min(rMin, s.roll); rMax = Math.max(rMax, s.roll);
    yMin = Math.min(yMin, s.y); yMax = Math.max(yMax, s.y);
    await p.waitForTimeout(160);
  }
  const deg = (v) => (v * 180 / Math.PI).toFixed(1);
  console.log(`${name.padEnd(11)} pitch ${deg(pMax - pMin).padStart(5)}deg  roll ${deg(rMax - rMin).padStart(5)}deg  heave ${(yMax - yMin).toFixed(2)}m`);
  await p.screenshot({ path: `${OUT}/${name.toLowerCase().replace(/\s+/g, '-')}.png` });
  await p.click('#btnSea'); await p.waitForTimeout(600);
}
console.log('errs', errs.slice(0, 3));
await b.close();
