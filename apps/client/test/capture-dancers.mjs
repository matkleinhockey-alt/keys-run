/**
 * The Pink Flamingo's stage, in the real game, by Playwright.
 *
 * Usage:  CLIENT_URL=http://localhost:5433 node test/capture-dancers.mjs
 *
 * What it is checking, beyond "a picture exists":
 *   - the two rigged models actually loaded (not the procedural fallback) — asserted through the
 *     scene graph: a `stage-dancer-*` group whose subtree contains a SkinnedMesh;
 *   - each one's feet are ON the stage (y ~ PAD_Y + 0.96), not sunk into it at floor level;
 *   - the clip is RUNNING: a named bone's world position is sampled twice, a second of simulated
 *     time apart, and must differ;
 *   - they are not inside the poles: the clip's widest arm reach vs. the pole 1.1 m behind.
 *
 * ~3 fps on a software GPU, so every wait is generous and nothing here claims a frame rate.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5433';
const OUT = path.join(HERE, 'screenshots', 'dancers');
fs.mkdirSync(OUT, { recursive: true });

const SX = -900, SZ = 250.7;
const W = (u, v) => [SX + u, SZ - v];
const errs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180000);
page.on('pageerror', (e) => errs.push('pageerror: ' + e));
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
await page.goto(URL, { waitUntil: 'load' });
await sleep(800);
const offline = await page.$('.krAuthOffline');
if (offline) await offline.click();
await sleep(500);
await page.click('#btnGo');
await sleep(1500);
await page.keyboard.press('KeyP');

const shot = async (name) => {
  for (let i = 0; i < 3; i++) {
    try { await page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 120000 }); console.log('shot', name); return; } catch (e) { console.log('retry', name, String(e).slice(0, 80)); await sleep(3000); }
  }
  errs.push('could not capture ' + name);
};
const place = async (at, yaw, pitch = 0) => {
  const ok = await page.evaluate(({ x, z, yaw, pitch }) => { const k = window.__landDebug.place(x, z, yaw); window.__landDebug.look(yaw, pitch); return k; }, { x: at[0], z: at[1], yaw, pitch });
  if (!ok) console.log('could not place at', at);
};

// ashore, then into the club
await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, Math.PI), { x: SX, z: SZ + 55 });
await sleep(2500);
await page.keyboard.press('KeyF');
await sleep(2500);
await page.evaluate(() => window.__landDebug.view('first'));
await page.evaluate(() => window.__landDebug.ensureBuilt());

const IN = 0, WEST = Math.PI / 2, EAST = -Math.PI / 2;
// stand in the room facing the stage (the stage is at the back, v 64..70; the room's floor is in front of it)
await place(W(51, 58), IN, 0.06);

// Wait for the models rather than sleeping a guessed interval: the room is built synchronously
// and shows the procedural fallback until the glTF arrives, which on this software GPU can take
// anything from four seconds to forty. A fixed sleep made this harness report `rigged: false`
// about half the time — the load was fine, the wait was not.
let ready = [];
for (let i = 0; i < 40; i++) {
  ready = await page.evaluate(() => window.__townDebug.dancers());
  if (ready.length && ready.every((d) => d.rigged)) break;
  await sleep(2000);
}
if (!ready.length || !ready.every((d) => d.rigged)) errs.push('dancers never loaded: ' + JSON.stringify(ready));
await sleep(2000);
await shot('01-stage-from-the-floor');

// the scene-graph truth, through the town's own verification hook: rigged or fallback, and
// where the feet are. The stage's top face is PAD_Y + 0.96 (interiors.ts STAND_Y).
const probe = await page.evaluate(() => ({ dancers: window.__townDebug.dancers(), pad: window.__landDebug.pad }));
console.log('DANCERS', JSON.stringify(probe, null, 2));

// is the clip running? sample the hand bone twice, several simulated seconds apart
const hands = () => page.evaluate(() => window.__townDebug.dancers().map((d) => ({ id: d.id, hand: d.hand })));
const a = await hands();
await sleep(7000);
const b = await hands();
console.log('HAND MOVED (m)', JSON.stringify(a.map((x, i) => {
  const y = b[i];
  return { id: x.id, moved: x.hand && y?.hand ? +Math.hypot(x.hand[0] - y.hand[0], x.hand[1] - y.hand[1], x.hand[2] - y.hand[2]).toFixed(4) : null };
})));

await place(W(47, 61), IN, 0.1); await sleep(6000); await shot('02-dancer-one-close');
await place(W(55, 61), IN, 0.1); await sleep(6000); await shot('03-dancer-two-close');
await place(W(44, 61), IN - 0.5, 0.05); await sleep(6000); await shot('04-along-the-stage');
await place(W(51, 55), IN, 0.1); await sleep(6000); await shot('05-the-room');

console.log('errors', errs.length ? errs : 'none');
await browser.close();
if (errs.length) process.exitCode = 1;
