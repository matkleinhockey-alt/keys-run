/**
 * Larry's POS. Forces a window in which he is out (he is not, most of the time), then parks the
 * player alongside so the raft, the tent, the kicker and the speech bubble are all in one frame.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'test/screenshots/larry'; fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.setDefaultTimeout(180000);
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto('http://localhost:5174', { waitUntil: 'load' }); await p.waitForTimeout(800);
const off = await p.$('button:has-text("Play offline")'); if (off) { await off.click(); await p.waitForTimeout(900); }
for (let i = 0; i < 4; i++) { const t = await p.textContent('#btnQualityStart').catch(() => ''); if (t && t.includes('High')) break; await p.keyboard.press('KeyG'); await p.waitForTimeout(250); }
await p.waitForTimeout(3500); await p.click('#btnGo'); await p.waitForTimeout(1500);

// Find a window where he is out. He is parked far from the player so the swap is allowed.
let st = null;
for (let k = 0; k <= 40 && !st; k++) {
  await p.evaluate((k) => {
    if (!window.__realNow) window.__realNow = Date.now.bind(Date);
    Date.now = () => window.__realNow() + k * 11 * 60 * 1000;
  }, k);
  await p.evaluate(() => window.__fishDebug.teleport(3900, -2700, 0));
  await p.waitForTimeout(900);
  const d = await p.evaluate(() => window.__fishDebug.larry());
  if (d.out) { console.log(`out at +${k} windows, route ${d.route}`); st = d; }
}
if (!st) { console.log('never out'); await b.close(); process.exit(0); }

// Let him putter a while so he is somewhere along the loop rather than at the seam, then pull
// alongside. Close enough for the bubble (SAY_M 130) and the tag.
await p.waitForTimeout(6000);
// Does he make way? Two fixes ten seconds apart, player parked alongside.
const m0 = await p.evaluate(() => window.__fishDebug.larry());
await p.evaluate(({ x, z }) => window.__fishDebug.teleport(x + 24, z + 24, Math.atan2(24, 24)), m0);
await p.waitForTimeout(16000);
const m1 = await p.evaluate(() => window.__fishDebug.larry());
await p.waitForTimeout(10000);
const m2 = await p.evaluate(() => window.__fishDebug.larry());
console.log(`made good in 10 s: ${Math.hypot(m2.x - m1.x, m2.z - m1.z).toFixed(1)} m  (expect ~10.5)`);
console.log(`alongside: out=${m2.out} route=${m2.route} x=${m2.x} z=${m2.z} depth=${m2.depth} visible=${m2.visible} speed=${m2.speedKn}kn`);
await p.screenshot({ path: `${OUT}/alongside.png` });
/*
 * Abeam, not astern. The chase camera sits directly behind the boat on its heading, so parking
 * the player pointed AT Larry puts the player's own transom squarely over him. Standing off to
 * one side and steering past is the only way to get the raft in shot.
 */
for (const [tag, dx, h] of [['abeam-port', 34, 0], ['abeam-stbd', -30, 0], ['abeam-near', 19, 0]]) {
  const d = await p.evaluate(() => window.__fishDebug.larry());
  await p.evaluate(({ x, z, dx, h }) => window.__fishDebug.teleport(x + dx, z + 6, h), { x: d.x, z: d.z, dx, h });
  await p.waitForTimeout(16000);
  await p.screenshot({ path: `${OUT}/${tag}.png` });
}
console.log('tag text:', await p.evaluate(() => [...document.querySelectorAll('#tags .tag')].map((e) => e.textContent).filter(Boolean)));
console.log('errs', errs.slice(0, 3));
await b.close();
