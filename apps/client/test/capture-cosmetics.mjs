/**
 * Every cosmetic the gift shop sells, actually worn, in the real game, by Playwright.
 *
 * Usage:  CLIENT_URL=http://localhost:5291 node test/capture-cosmetics.mjs [land|boat|panel|all]
 *
 *   land   walk ashore at Boot Key Harbor City Marina, turn the camera round to face the player, and
 *          photograph the body in each shirt / cap / pair of shades (and with everything taken off).
 *   boat   the captain at the helm in each outfit (aft chase camera too), and each stern flag.
 *   panel  the gift shop panel with its changing room.
 *
 * Purchases go through the shared `buy()` via window.__landDebug.wardrobe (verification hook only;
 * the till is not connected to the wallet in this branch). Software GPU, ~3 fps: waits are generous
 * and nothing here makes a frame-rate claim.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SX, SZ } from './marina.mjs';
import { CLIENT_URL } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = CLIENT_URL;
const OUT = path.join(HERE, 'screenshots', 'cosmetics');
fs.mkdirSync(OUT, { recursive: true });
const which = process.argv[2] || 'all';
// Imported, not copied: this pair went stale once already — see test/marina.mjs.
// (SX/SZ keep their names so the rest of each script is untouched.)
const errs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(page) {
  page.on('pageerror', (e) => errs.push('pageerror: ' + e));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.goto(URL, { waitUntil: 'load' });
  await sleep(800);
  const offline = await page.$('.krAuthOffline');
  if (offline) await offline.click();
  await sleep(500);
  await page.click('#btnGo');
  await sleep(1500);
}
const shot = async (page, name, clip) => {
  for (let i = 0; i < 3; i++) {
    try { await page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 120000, ...(clip ? { clip } : {}) }); console.log('shot', name); return; } catch (e) { console.log('retry', name, String(e).slice(0, 80)); await sleep(3000); }
  }
  errs.push('could not capture ' + name);
};
const KEYS = {
  shirt: ['hawaiian', 'breton', 'sunset', 'luigi'],
  cap: ['conch', 'bucket', 'luigi'],
  glasses: ['aviator', 'round', 'neon'],
  flag: ['conch', 'fishon', 'loser'],
};

async function tieUp(page) {
  await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, Math.PI), { x: SX, z: SZ + 55 });
  await sleep(2500);
  await page.keyboard.press('KeyF');
  await sleep(2500);
}

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: which === 'close' ? 3 : 1 });
  page.setDefaultTimeout(180000);
  await boot(page);
  const wd = (fn, arg) => page.evaluate(fn, arg);

  if (which === 'land' || which === 'close' || which === 'all') {
    const P = which === 'close' ? 'close-' : 'land-';
    await tieUp(page);
    // Stand on the promenade, face the camera back at the body: place() sets body yaw and camera yaw
    // together, look() then swings only the camera, so we see the player's front.
    await wd(() => { window.__landDebug.view('third'); window.__landDebug.place(-900, 252, 0); });
    await sleep(1500);
    await wd(() => window.__landDebug.look(Math.PI, -0.02));
    await sleep(2500);
    const clip = which === 'close' ? { x: 540, y: 262, width: 200, height: 150 } : { x: 400, y: 80, width: 480, height: 560 };
    await shot(page, `${P}00-stock`, clip);
    await wd(() => window.__landDebug.wardrobe.giveAll());
    for (const [slot, names] of Object.entries(KEYS)) {
      if (slot === 'flag') continue;
      for (const n of names) {
        // strip the rest first so each image shows exactly one item against the stock look
        await wd(() => { for (const s of ['shirt', 'cap', 'glasses']) window.__landDebug.wardrobe.takeOff(s); });
        await wd((k) => window.__landDebug.wardrobe.wear(k), `cosmetic.${slot}.${n}`);
        await sleep(2500);
        await shot(page, `${P}${slot}-${n}`, clip);
      }
    }
    // everything at once, then a take-off, to show the swap and removal
    await wd(() => { const w = window.__landDebug.wardrobe; for (const k of ['cosmetic.shirt.hawaiian', 'cosmetic.cap.bucket', 'cosmetic.glasses.aviator']) w.wear(k); });
    await sleep(2500);
    await shot(page, `${P}all-three`, clip);
    await wd(() => { window.__landDebug.wardrobe.takeOff('cap'); });
    await sleep(2500);
    await shot(page, `${P}cap-taken-off`, clip);
    console.log('worn', JSON.stringify(await wd(() => window.__landDebug.wardrobe.state().wearing)));
    // the back view (what you see walking) for the shirt patterns
    await wd(() => { window.__landDebug.wardrobe.wear('cosmetic.shirt.hawaiian'); window.__landDebug.look(0, -0.02); });
    await sleep(2500);
    await shot(page, `${P}back-hawaiian`, clip);
  }

  if (which === 'boat' || which === 'all') {
    if (await wd(() => window.__landDebug.mode() === 'land')) { await page.keyboard.press('KeyB'); await sleep(3000); }
    await wd(() => window.__landDebug.wardrobe.giveAll());
    // zoom the chase camera all the way in (wheel, like a player would) so the captain and the stern
    // flag are more than a few pixels tall
    await page.mouse.move(640, 360);
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -120);
    await sleep(3000);
    const bclip = { x: 440, y: 220, width: 400, height: 260 };
    await wd(() => { for (const s of ['shirt', 'cap', 'glasses', 'flag']) window.__landDebug.wardrobe.takeOff(s); });
    await sleep(2500);
    await shot(page, 'boat-00-stock', bclip);
    for (const n of KEYS.shirt) {
      await wd((k) => { window.__landDebug.wardrobe.wear(k); }, `cosmetic.shirt.${n}`);
      await sleep(2500);
      await shot(page, `boat-shirt-${n}`, bclip);
    }
    await wd(() => { for (const s of ['shirt']) window.__landDebug.wardrobe.takeOff(s); });
    for (const n of KEYS.cap) {
      await wd((k) => { window.__landDebug.wardrobe.wear(k); }, `cosmetic.cap.${n}`);
      await sleep(2500);
      await shot(page, `boat-cap-${n}`, bclip);
    }
    for (const n of KEYS.flag) {
      await wd((k) => { window.__landDebug.wardrobe.wear(k); }, `cosmetic.flag.${n}`);
      await sleep(2500);
      await shot(page, `boat-flag-${n}`, bclip);
    }
    await wd(() => { window.__landDebug.wardrobe.takeOff('flag'); });
    await sleep(2500);
    await shot(page, 'boat-flag-struck', bclip);
    // first person from the helm: the arms on the wheel wear the shirt's sleeves
    await wd(() => window.__landDebug.wardrobe.wear('cosmetic.shirt.hawaiian'));
    await page.keyboard.press('Digit1');
    await sleep(3500);
    await shot(page, 'boat-first-person-helm');
    await page.keyboard.press('Digit1'); // back to third
  }

  if (which === 'panel' || which === 'all') {
    if (!(await wd(() => window.__landDebug.mode() === 'land'))) await tieUp(page);
    await wd(() => window.__landDebug.wardrobe.giveAll());
    const at = await wd(() => window.__landDebug.interactWorld('door-gifts'));
    console.log('gifts counter at', JSON.stringify(at));
    await wd(([x, z]) => window.__landDebug.place(x, z, 0), at);
    await sleep(1500);
    await page.keyboard.press('KeyF');
    console.log('panel', await wd(() => window.__landDebug.state().panel));
    await sleep(2000);
    await shot(page, 'panel-changing-room');
  }

  console.log('errors', JSON.stringify(errs));
  await browser.close();
};
run().catch((e) => { console.error(e); process.exit(1); });
