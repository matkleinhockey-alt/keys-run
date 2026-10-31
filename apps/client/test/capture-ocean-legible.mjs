/**
 * Worked water is legible: the same reef, same camera, same moment, pristine and then fished out.
 * The ledger needs a signed-in account, so the worked-out half uses the verification-only
 * `window.__oceanDebug.force(recovery)` (game/world.ts) to stand in for what the ledger answers
 * after ~30 catches (recovery 0.08). Everything else is the real game and the real diver camera.
 *
 *   CLIENT_PORT=5290 node test/capture-ocean-legible.mjs
 *
 * Output: test/screenshots/ocean-legible/{pristine,worked}.png and a printed fish count for each.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_URL } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'screenshots', 'ocean-legible');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(CLIENT_URL, { waitUntil: 'load' });
page.setDefaultTimeout(120000);
await page.waitForTimeout(800);
// Signed out: the real offline game, which is also the proof that the ledger is simply absent.
for (let i = 0; i < 12; i++) {
  const o = await page.$('button:has-text("Play offline")');
  if (o) { await o.click().catch(() => {}); await page.waitForTimeout(900); }
  if (!(await page.$('.krAuthGate'))) break;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(2500);
await page.click('#btnGo', { timeout: 30000 }).catch(() => {}); // may already be past the start screen
await page.waitForTimeout(1000);

// Sombrero Reef crest, as capture-fish-visible-screenshots.mjs.
const X = 60, Z = 1462, YAW = 0;
await page.evaluate(({ X, Z, YAW }) => window.__diverDebug.enterAt(2.0, X, Z, YAW), { X, Z, YAW });
await page.evaluate((yaw) => window.__diverDebug.setLook(yaw, -0.08), YAW);
await page.waitForTimeout(3000);

// Aim at the biggest school nearby from a fixed standoff, then freeze the camera for both shots.
const schools = await page.evaluate(() => window.__fishDebug.activeSchools());
let anchor = null;
for (const s of schools) {
  const d = Math.hypot(s.cx - X, s.cz - Z);
  if (d > 150) continue;
  if (!anchor || s.count > anchor.count) anchor = { ...s, d };
}
if (anchor) {
  const fx = -Math.sin(anchor.heading), fz = -Math.cos(anchor.heading);
  const camX = anchor.cx - fx * 8, camZ = anchor.cz - fz * 8;
  const yaw = Math.atan2(-(anchor.cx - camX), -(anchor.cz - camZ));
  const col = await page.evaluate(({ tx, tz }) => window.__fishDebug.waterColumnAt(tx, tz, performance.now() / 1000), { tx: anchor.cx, tz: anchor.cz });
  const eyeY = col.floor + (col.surf - col.floor) * 0.5;
  await page.evaluate(({ camX, camZ, eyeY, yaw }) => window.__diverDebug.enterAt(Math.max(0.3, -eyeY), camX, camZ, yaw), { camX, camZ, eyeY, yaw });
  await page.evaluate((yaw) => window.__diverDebug.setLook(yaw, -0.05), yaw);
}
await page.waitForTimeout(1200);

const shots = [['pristine', null], ['worked', 0.08]];
const result = {};
for (const [name, rec] of shots) {
  await page.evaluate((r) => window.__oceanDebug.force(r), rec);
  await page.waitForTimeout(1500);
  const fish = await page.evaluate(() => window.__fishDebug.stats().fish);
  const drawn = await page.evaluate(() => window.__fishDebug.stats().drawnFish);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  result[name] = { recovery: rec ?? 1, fishInSchools: fish, drawnAfterCulling: drawn, anchor: anchor ? `${anchor.type}:${anchor.count}` : null };
}
console.log(JSON.stringify(result, null, 2));
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
