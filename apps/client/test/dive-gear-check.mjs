/**
 * Browser check for dive gear: the HUD gauge and the actual survivable bottom time move when gear
 * is owned. Uses `window.__diverGear` (entities/diver/gear.ts) as a fake inventory and
 * `window.__diverDebug` (game/world.ts) for the live diver state.
 *
 * Bottom time is measured in SIMULATED seconds without waiting them out (software GL runs ~3 fps
 * with a 0.05 s/frame clamp, so a 252 s breath hold is ~25 minutes of wall clock): resting on the
 * seabed burns exactly ATA * dt of air per step, so  simSeconds = delta(air) / ATA  over a short
 * real run, and  bottom time = airMax / ATA  is then read straight off the live state. The final
 * leg also drives a REAL blackout (air set to a few seconds) to prove recovery is untouched.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5811';
const OUT = path.join(HERE, 'screenshots', 'dive-gear');
fs.mkdirSync(OUT, { recursive: true });
const X = 60, Z = 0.000012 * X * X + 1485; // upper wall, ~9 m column (see dive-integration.mjs)
const DEPTH = 6;
const errs = [];
const out = {};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(600);
await page.click('.krAuthOffline', { timeout: 120000 }).catch((e) => console.log('no auth gate', String(e).slice(0, 80)));
await page.click('#btnGo', { timeout: 120000 });
await page.waitForTimeout(800);
await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: X, z: Z });
await page.waitForTimeout(800);

const hud = () => page.evaluate(() => ({
  pct: document.getElementById('airPct')?.textContent,
  fill: document.getElementById('breathFill')?.style.width,
  warn: document.getElementById('ascentWarn')?.textContent,
}));
const st = () => page.evaluate(() => { const s = window.__diverDebug.state(); return s && { air: s.air, airMax: s.airMax, y: s.y, blacked: s.blackedOut, vx: s.vx, vz: s.vz }; });

async function dive(label, gear) {
  await page.evaluate((g) => window.__diverGear.set(g), gear);
  await page.evaluate(({ x, z, d }) => window.__diverDebug.enterAt(d, x, z, 0), { x: X, z: Z, d: DEPTH });
  await page.waitForTimeout(400);
  const a = await st();
  // Rest on the spot for a few real frames; the diver floats/sinks a little, so use the measured
  // depth-averaged ATA of the two samples rather than assuming a constant.
  await page.waitForTimeout(6000);
  const b = await st(), h = await hud();
  const ata = 1 + (-(a.y + b.y) / 2) / 10;
  const simS = (a.air - b.air) / ata;
  const g = await page.evaluate(() => window.__diverGear.get());
  out[label] = { airMax: a.airMax, hud: h, simSecondsMeasured: +simS.toFixed(2), pctPerSimSecond: +(((a.air - b.air) / a.airMax * 100) / Math.max(simS, 1e-6)).toFixed(3), restBottomTimeAtThisDepthS: +(a.airMax / ata).toFixed(1), fillsLeft: g.fills, fillsSpent: g.spent };
  // HUD proof independent of how little sim time the software renderer gave us: park the air at
  // exactly half of THIS dive's budget. With the old pinned constant the gauge would read
  // airMax/2/90 (140% clamped to 100%) on a 252 s budget; scaled it must read 50%.
  await page.evaluate(() => { const s = window.__diverDebug.state(); s.air = s.airMax * 0.5; });
  await page.waitForTimeout(1500);
  out[label].hudAtHalfBudget = await hud();
  // ...and at 20% the "air low" warning must fire relative to the budget (needs depth > 3 m).
  await page.evaluate(() => { const s = window.__diverDebug.state(); s.air = s.airMax * 0.2; });
  await page.waitForTimeout(1500);
  out[label].warnAt20pct = (await hud()).warn;
  console.log(label, JSON.stringify(out[label]));
  await page.evaluate(() => window.__diverDebug.exitToBoat());
  await page.waitForTimeout(300);
}

await dive('none', {});
await dive('wetsuit+fins+mask (no tank)', { breathMul: 1.18 * 1.08, swimMul: 1.28, viewBonusM: 6 });
await dive('full kit, 1 fill', { breathMul: 2.2 * 1.18 * 1.08, swimMul: 1.28, viewBonusM: 6, hasTank: true, fills: 1 });
await dive('full kit, 0 fills (tank dead)', { breathMul: 2.2 * 1.18 * 1.08, swimMul: 1.28, viewBonusM: 6, hasTank: true, fills: 0 });

// Mask: same view, bonus 0 vs 6, looking along the wall. Pixel-difference proves the shader reads it.
async function shot(label, bonus) {
  await page.evaluate((b) => window.__diverGear.set({ viewBonusM: b }), bonus);
  await page.evaluate(({ x, z }) => window.__diverDebug.enterAt(4, x, z, 0), { x: X, z: Z });
  await page.evaluate(() => window.__diverDebug.setLook(Math.PI / 2, -0.05));
  await page.waitForTimeout(2500);
  const buf = await page.screenshot({ path: path.join(OUT, `view-${label}.png`) });
  await page.evaluate(() => window.__diverDebug.exitToBoat());
  await page.waitForTimeout(300);
  return buf;
}
const a = await shot('nomask', 0), b = await shot('mask', 6);
out.maskScreenshotsIdentical = Buffer.compare(a, b) === 0;
console.log('mask screenshots identical?', out.maskScreenshotsIdentical);

// Real blackout + recovery with full gear: starve the air, let the real sim black out, expect the
// boat wake-up (mode back to boat) and a usable diver afterwards.
await page.evaluate(() => window.__diverGear.set({ breathMul: 2.804, hasTank: true, fills: 1, swimMul: 1.28 }));
await page.evaluate(({ x, z }) => window.__diverDebug.enterAt(12, x, z, 0), { x: X, z: Z });
await page.evaluate(() => { window.__diverDebug.state().air = 1.5; });
await page.waitForTimeout(500);
out.warnAtLowAir = await hud();
let modeAfter = 'diver', sawBlackout = false;
for (let i = 0; i < 400 && modeAfter === 'diver'; i++) {
  await page.waitForTimeout(500);
  const s = await st();
  if (s?.blacked) sawBlackout = true;
  modeAfter = await page.evaluate(() => window.__diverDebug.mode());
}
out.blackout = { sawBlackout, modeAfter };
console.log('blackout', JSON.stringify(out.blackout), 'warn', JSON.stringify(out.warnAtLowAir));
out.consoleErrors = errs.slice(0, 10);
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(out, null, 2));
await browser.close();
