/**
 * The moving sandbar party and its beer can on the chart.
 *
 * Two things to see: the raft-up is where the chart says it is, and when the clock rolls over to
 * a new period the whole party (and the can) is somewhere else. The clock is faked by overriding
 * `Date.now` in the page, which is exactly the seam the feature reads — nothing else to stub.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'test/screenshots/sandbar-move'; fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.setDefaultTimeout(180000);
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto('http://localhost:5174', { waitUntil: 'load' });
await p.waitForTimeout(800);
const off = await p.$('button:has-text("Play offline")'); if (off) { await off.click(); await p.waitForTimeout(900); }
for (let i = 0; i < 4; i++) { const t = await p.textContent('#btnQualityStart').catch(() => ''); if (t && t.includes('High')) break; await p.keyboard.press('KeyG'); await p.waitForTimeout(250); }
await p.waitForTimeout(3500);
await p.click('#btnGo'); await p.waitForTimeout(1500);

const shot = async (tag) => {
  const d = await p.evaluate(() => window.__fishDebug.sandbar());
  if (!d) { console.log(tag, 'NO SITE'); return null; }
  // Park IN the raft. Standing off and pointing the bow at it does not work: the camera is not
  // locked behind the boat, so the bar ends up wherever the orbit happens to be looking.
  await p.evaluate(({ x, z }) => window.__fishDebug.teleport(x + 70, z + 70, Math.atan2(70, 70)), { x: d.x, z: d.z });
  await p.waitForTimeout(15000);
  const after = await p.evaluate(() => window.__fishDebug.sandbar());
  console.log(`${tag}: idx=${after.index}/${after.sites} x=${after.x} z=${after.z.toFixed(0)} depth=${after.depth} boats=${after.boats} visible=${after.visible}`);
  await p.screenshot({ path: `${OUT}/${tag}-scene.png` });
  const box = await p.$('#mapbox');
  if (box) { await box.click(); await p.waitForTimeout(400); await box.screenshot({ path: `${OUT}/${tag}-chart.png` }); await box.click(); await p.waitForTimeout(300); }
  return after;
};

const first = await shot('bar-a');

// Roll the clock forward a period at a time, out of sight of the old bar, until it moves.
let moved = null;
for (let k = 1; k <= 12 && !moved; k++) {
  await p.evaluate((k) => {
    const PERIOD = 40 * 60 * 1000;
    if (!window.__realNow) window.__realNow = Date.now.bind(Date);
    Date.now = () => window.__realNow() + k * PERIOD;
  }, k);
  // Far away, so the relocation is allowed to happen at all.
  await p.evaluate(() => window.__fishDebug.teleport(3600, -2400, 0));
  await p.waitForTimeout(1200);
  const d = await p.evaluate(() => window.__fishDebug.sandbar());
  if (d && d.index !== first.index) { console.log(`moved after +${k} periods: ${first.index} -> ${d.index}`); moved = d; }
}
if (moved) await shot('bar-b');
else console.log('never moved');

// It must NOT move while you are standing on it.
if (moved) {
  const here = await p.evaluate(() => window.__fishDebug.sandbar());
  await p.evaluate(({ x, z }) => window.__fishDebug.teleport(x + 60, z + 60, 0), here);
  await p.waitForTimeout(1500);
  await p.evaluate(() => { const P = 40 * 60 * 1000; const n = window.__realNow; Date.now = () => n() + 97 * P; });
  await p.waitForTimeout(2500);
  const still = await p.evaluate(() => window.__fishDebug.sandbar());
  console.log(`held while in sight: ${still.index === here.index ? 'YES' : 'NO (teleported under the player)'} idx ${here.index} -> ${still.index}`);
}
console.log('errs', errs.slice(0, 3));
await b.close();
