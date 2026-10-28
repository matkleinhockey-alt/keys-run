/**
 * Aim-and-shoot for street life: put the camera at a spot (local u, v) looking at a target (u, v, height),
 * optionally jump the street's clock first, and screenshot. For finding a squirrel on a palm or the
 * loader at his tailgate, where `capture-life.mjs`'s fixed cameras would miss.
 *
 * Usage:  CLIENT_URL=http://localhost:5394 node test/shoot.mjs <prefix> <spec.json>
 *   spec.json: [{ "name": "squirrel", "cam": [-54, 28], "target": [-54, 22, 2.5], "jump": 25, "dusk": false, "wait": 3000 }, ...]
 *   An entry may use "follow": "<id>" instead of "target": it looks at that person or animal (from `__townDebug`), `dist` m away from the side
 *   the camera is on. `dusk: true` entries are taken after one sunset toggle, after all the day ones.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SX, SZ } from './marina.mjs';
import { CLIENT_URL } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = CLIENT_URL;
const prefix = process.argv[2] || 'shot';
const spec = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const OUT = path.join(HERE, 'screenshots', 'polish');
fs.mkdirSync(OUT, { recursive: true });
// Imported, not copied: this pair went stale once already — see test/marina.mjs.
// (SX/SZ keep their names so the rest of each script is untouched.)
const W = (u, v) => [SX + u, SZ - v];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180000);
page.on('pageerror', (e) => errs.push('pageerror: ' + e));
page.on('console', (m) => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text())) errs.push('console: ' + m.text()); });
await page.goto(URL, { waitUntil: 'load' });
await sleep(800);
const off = await page.$('.krAuthOffline'); if (off) await off.click();
await sleep(500);
await page.click('#btnGo'); await sleep(1500);
await page.keyboard.press('KeyP');
await page.addStyleTag({ content: '#hud,#tags,#toast{display:none!important}' });
await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, Math.PI), { x: SX, z: SZ + 55 });
await sleep(3000);
await page.keyboard.press('KeyF'); await sleep(3000);
await page.evaluate(() => window.__landDebug.ensureBuilt());

async function lookup(id) {
  return page.evaluate((id) => {
    const p = window.__townDebug.people().find((q) => q.id === id);
    if (p) return { u: p.u, v: p.v, h: 1.2, tier: p.tier, stance: p.stance };
    const a = window.__townDebug.wildlife().animals.find((q) => q.id === id);
    return a ? { u: a.u, v: a.v, h: a.y + 0.3, tier: a.drawn, stance: a.stance } : null;
  }, id);
}

async function take(e) {
  if (e.jump !== undefined) { await page.evaluate((T) => window.__townDebug.jump(T), e.jump); }
  let [cu, cv] = e.cam, target = e.target;
  if (e.follow) {
    // two passes: the first frame after a teleport/jump has to run before the figure is in the right place
    let f = await lookup(e.follow);
    await page.evaluate(({ x, z }) => window.__landDebug.place(x, z, 0), { x: W(e.cam[0], e.cam[1])[0], z: W(e.cam[0], e.cam[1])[1] });
    await sleep(2500);
    f = await lookup(e.follow);
    if (!f) { errs.push('no such figure ' + e.follow); return; }
    target = [f.u, f.v, f.h];
    const d = e.dist ?? 3.5, ang = e.angle ?? 0;
    // stand `d` metres from it toward the street (the side `angle` picks), so the camera is on the walkway
    cu = f.u + Math.sin(ang) * d; cv = f.v - Math.cos(ang) * d;
  }
  const [x, z] = W(cu, cv);
  const du = target[0] - cu, dv = target[1] - cv, dist = Math.hypot(du, dv);
  const yaw = Math.atan2(-du, dv), pitch = Math.atan2(target[2] - 1.65, dist);
  await page.evaluate(({ x, z, yaw, pitch }) => { window.__landDebug.place(x, z, yaw); window.__landDebug.look(yaw, pitch); }, { x, z, yaw, pitch });
  await sleep(e.wait ?? 3500);
  if (process.env.PROBE) console.log(e.name, JSON.stringify((await page.evaluate(() => window.__townDebug.people())).filter((q) => q.tier !== 'off').map((q) => [q.id, +q.u.toFixed(1), +q.v.toFixed(1), q.tier, q.stance]).slice(0, 40)));
  for (let i = 0; i < 3; i++) {
    try { await page.screenshot({ path: path.join(OUT, `${prefix}-${e.name}.png`), timeout: 120000 }); console.log('shot', e.name); return; } catch (err) { await sleep(3000); }
  }
  errs.push('could not capture ' + e.name);
}

for (const e of spec.filter((s) => !s.dusk)) await take(e);
if (spec.some((s) => s.dusk)) {
  await page.keyboard.press('KeyO');
  await sleep(100000);
  for (const e of spec.filter((s) => s.dusk)) await take(e);
}
console.log(JSON.stringify(await page.evaluate(() => window.__townDebug.wildlife())).slice(0, 1500));
await browser.close();
console.log('errors:', errs.length); errs.slice(0, 10).forEach((e) => console.log('  ', e.slice(0, 300)));
