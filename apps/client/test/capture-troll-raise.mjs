/**
 * A fish coming up on a lure: forces a raise with `__fishDebug.trollRaiseNow` and shoots the
 * RAISE_S seconds of approach, the eat, and the first moments of the fight, from over the transom.
 *
 * Usage: CLIENT_URL=http://localhost:5191 node test/capture-troll-raise.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'test/screenshots/troll-raise'; fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.setDefaultTimeout(180000); const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));
p.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
await p.goto(process.env.CLIENT_URL || 'http://localhost:5191', { waitUntil: 'load' }); await p.waitForTimeout(800);
const off = await p.$('button:has-text("Play offline")'); if (off) { await off.click(); await p.waitForTimeout(900); }
for (let i = 0; i < 4; i++) { const t = await p.textContent('#btnQualityStart').catch(() => ''); if (t && t.includes('High')) break; await p.keyboard.press('KeyG'); await p.waitForTimeout(250); }
await p.waitForTimeout(3500);
await p.click('#btnGo'); await p.waitForTimeout(1500);
await p.evaluate(() => window.__fishDebug.teleport(-900, 2600, Math.PI));
await p.waitForTimeout(2500);
await p.evaluate(() => window.__fishDebug.trollToggle());
await p.keyboard.down('KeyW');
await p.waitForTimeout(12000);
await p.waitForTimeout(2500);
console.log('before:', JSON.stringify(await p.evaluate(() => window.__fishDebug.troll())));
console.log('raise started:', await p.evaluate(() => window.__fishDebug.trollRaiseNow()));
for (let i = 0; i < 6; i++) {
  const r = await p.evaluate(() => ({ ...window.__fishDebug.trollRaiseState(), rod: window.__fishDebug.troll().rod, cam: window.__fishDebug.fishCam() }));
  console.log(`  r${i}`, JSON.stringify(r));
  await p.screenshot({ path: `${OUT}/r${String(i).padStart(2, '0')}.png` });
  await p.waitForTimeout(40);
}
await p.keyboard.up('KeyW');
console.log('after:', JSON.stringify(await p.evaluate(() => window.__fishDebug.troll())));
console.log('errs', errs.slice(0, 4));
await b.close();
