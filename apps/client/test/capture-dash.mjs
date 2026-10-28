/**
 * The helm cluster: tach, speedo and trim, at idle and wide open.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { CLIENT_URL } from './server.mjs';
const OUT = 'test/screenshots/dash'; fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.setDefaultTimeout(120000);
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(CLIENT_URL, { waitUntil: 'load' }); await p.waitForTimeout(800);
const off = await p.$('button:has-text("Play offline")'); if (off) { await off.click(); await p.waitForTimeout(900); }
await p.waitForTimeout(3500);
await p.click('#btnGo'); await p.waitForTimeout(2500);

const shot = async (tag) => {
  const g = await p.$('#gauges');
  await g.screenshot({ path: `${OUT}/${tag}.png` });
  const d = await p.evaluate(() => ({
    rpm: document.getElementById('gRpm')?.textContent,
    kn: document.getElementById('gSpd')?.textContent,
    trim: document.getElementById('gTrimV')?.textContent,
    needles: [...document.querySelectorAll('#gCluster .needle')].map((n) => n.style.transform),
  }));
  console.log(tag, JSON.stringify(d));
};

await shot('idle');
// Open her up and let the revs and the needle settle.
await p.keyboard.down('KeyW');
await p.waitForTimeout(14000);
await shot('wot');
await p.keyboard.up('KeyW');
await p.waitForTimeout(6000);
await shot('coasting');
// Trim mode, so the trim needle and its lamp can be seen moving.
await p.keyboard.press('KeyT'); await p.waitForTimeout(400);
for (let i = 0; i < 20; i++) { await p.keyboard.press('ArrowUp'); await p.waitForTimeout(90); }
await shot('trimmed');
await p.screenshot({ path: `${OUT}/full.png` });
console.log('errs', errs.slice(0, 3));
await b.close();
