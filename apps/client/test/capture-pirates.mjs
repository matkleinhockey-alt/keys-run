/**
 * Verification screenshots for the pirates (src/entities/life/pirates.ts).
 *
 * The real schedule is 30 wall-clock minutes, which this sandbox cannot wait out (software GL,
 * ~3 fps, and the fixed-step sim clamps each rendered frame to 0.05 s), so this summons a visit
 * with the dev-only `__pirateDebug.summon(distM)` at a short spawn distance and follows it through
 * `__pirateDebug.state()`. No fps claims: everything here is waited on by *state*, not by time.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5188';
const OUT = path.join(HERE, 'screenshots', 'pirates');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(300000);
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(900);
const offline = page.locator('.krAuthOffline');
if (await offline.count()) { await offline.click(); await page.waitForTimeout(600); }
await page.click('#btnGo');
await page.waitForTimeout(2500);

const state = () => page.evaluate(() => window.__pirateDebug.state());
const boat = () => page.evaluate(() => window.__fishDebug.boatState());
const waitFor = async (pred, label, ms = 240000) => {
  const t0 = Date.now();
  for (;;) {
    const s = await state();
    if (pred(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}: ${JSON.stringify(s)}`);
    await page.waitForTimeout(700);
  }
};
/** Turns the boat (the chase camera follows its heading) to face the pirates. */
const faceThem = async () => {
  const [s, b] = [await state(), await boat()];
  const h = Math.atan2(-(s.x - b.x), -(s.z - b.z));
  await page.evaluate(([x, z, h]) => window.__fishDebug.teleport(x, z, h), [b.x, b.z, h]);
};

console.log('before summon:', JSON.stringify(await state()));
await page.screenshot({ path: path.join(OUT, '00-away.png') });
const START_DIST = Number(process.env.PIRATE_DIST || 260);
await page.evaluate((d) => window.__pirateDebug.summon(d), START_DIST);
const first = await waitFor((s) => s.phase !== 'away', 'approach');
console.log('arrived over the horizon:', JSON.stringify(first));
await faceThem();
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(OUT, '01-approach-far.png') });

await waitFor((s) => s.dist < 150, 'dist<150');
await faceThem();
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(OUT, '02-approach-near.png') });

await waitFor((s) => s.phase === 'linger' && s.beatsSpoken >= 1, 'first hail');
await faceThem();
await page.waitForTimeout(1200);
console.log('toast:', await page.evaluate(() => document.getElementById('toast')?.textContent));
await page.screenshot({ path: path.join(OUT, '03-hail.png') });

// Beauty shots from the water, using the debug camera override.
const ps = await state();
for (const [name, dx, dy, dz] of [['04-ship-broadside', 24, 5, 10], ['05-ship-stern', 8, 4, 30], ['06-ship-bow', -14, 3.5, -26], ['07-ship-rig', 30, 7, 0]]) {
  const s = await state();
  await page.evaluate(([x, y, z, lx, ly, lz]) => { window.__fishDebugCamera = { x, y, z, lookX: lx, lookY: ly, lookZ: lz }; }, [s.x + dx, dy, s.z + dz, s.x, 3.6, s.z]);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
}
await page.evaluate(() => { delete window.__fishDebugCamera; });
await faceThem();

if (process.env.PIRATE_FULL) {
  await waitFor((s) => s.phase === 'depart', 'depart', 3600000);
  console.log('departing:', JSON.stringify(await state()));
  await page.screenshot({ path: path.join(OUT, '08-departing.png') });
  await waitFor((s) => s.phase === 'away', 'gone', 3600000);
  console.log('gone:', JSON.stringify(await state()));
}
await browser.close();
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors');
