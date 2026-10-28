/**
 * The fight gauge and the boat, with a fish on.
 *
 * Two things to prove: the bar runs red while the hook is actually tearing (tension past
 * HOOK_TEAR), and the boat stops instead of driving itself around behind you.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { CLIENT_URL } from './server.mjs';
const OUT = 'test/screenshots/fight'; fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.setDefaultTimeout(120000);
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(CLIENT_URL, { waitUntil: 'load' }); await p.waitForTimeout(800);
const off = await p.$('button:has-text("Play offline")'); if (off) { await off.click(); await p.waitForTimeout(900); }
await p.waitForTimeout(3500); await p.click('#btnGo'); await p.waitForTimeout(2000);
const chainZ = (x) => 0.000012 * x * x;
await p.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: 1200, z: chainZ(1200) + 1500 });
await p.waitForTimeout(12000);
await p.evaluate(() => window.__fishDebug.trollToggle());
await p.waitForTimeout(9000);
// Keep hooking until something big enough to endanger itself turns up — a 3 lb mackerel
// cannot tear the hook and is SUPPOSED to leave the bar green.
let f0 = null, before = null;
for (let tries = 0; tries < 12; tries++) {
  before = await p.evaluate(() => window.__fishDebug.boatState());
  await p.evaluate(() => window.__fishDebug.trollStrikeNow());
  await p.waitForTimeout(1200);
  f0 = await p.evaluate(() => window.__fishDebug.fightInfo());
  if (f0 && f0.weight >= 15) break;
  // Too small: break it off by hand and get back on the troll.
  await p.evaluate(() => window.__fishDebug.loseFish && window.__fishDebug.loseFish());
  await p.keyboard.down('Space');
  for (let i = 0; i < 120 && (await p.evaluate(() => window.__fishDebug.fightInfo())); i++) await p.waitForTimeout(400);
  await p.keyboard.up('Space');
  await p.keyboard.press('Space'); await p.waitForTimeout(600);
  await p.waitForTimeout(2000);
}
console.log(`hooked ${f0.key} ${f0.weight}lb at ${before.speed.toFixed(2)} m/s`);
// Speed trace through the first seconds of the fight: does the boat stop?
const trace = [];
for (let i = 0; i < 10; i++) { trace.push((await p.evaluate(() => window.__fishDebug.boatState())).speed); await p.waitForTimeout(700); }
console.log('speed after hookup:', trace.map((v) => v.toFixed(2)).join(' -> '));

await p.keyboard.down('Space');
let redSeen = 0, overSeen = 0, slackSeen = 0, n = 0, maxSpeed = 0, shot = false;
let warnSeen = new Set();
for (let i = 0; i < 220; i++) {
  await p.waitForTimeout(300);
  const d = await p.evaluate(() => {
    const fT = document.getElementById('fT');
    const f = window.__fishDebug.fightInfo();
    return f && { cls: fT.className, w: fT.style.width, warn: fT.parentElement.style.getPropertyValue('--warn'), t: f.tension, lim: f.limit, speed: window.__fishDebug.boatState().speed };
  });
  if (!d) break;
  n++; maxSpeed = Math.max(maxSpeed, Math.abs(d.speed));
  if (i > 12) maxSpeed = Math.max(0, maxSpeed);
  warnSeen.add(d.warn);
  if (d.cls === 'hot') redSeen++; if (d.cls === 'over') overSeen++; if (d.cls === 'slack') slackSeen++;
  if (!shot && d.cls === 'hot') { await p.screenshot({ path: `${OUT}/hot.png` }); shot = true; }
}
await p.keyboard.up('Space');
console.log(`samples=${n}  hot=${redSeen} (${(100*redSeen/n).toFixed(0)}%)  over=${overSeen}  slack=${slackSeen}`);
console.log(`boat: fastest |speed| seen during the fight = ${maxSpeed.toFixed(2)} m/s`);
console.log(`--warn values painted: ${[...warnSeen].slice(0, 6).join(' ')}`);
console.log('errs', errs.slice(0, 2));
await b.close();
