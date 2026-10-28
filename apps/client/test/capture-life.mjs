/**
 * Street-life and polish captures: the SAME cameras before and after a change, side by side.
 *
 * Usage:  CLIENT_URL=http://localhost:5394 node test/capture-life.mjs <label> [day|dusk|perf|all]
 *
 *   day   fixed street cameras by day  -> test/screenshots/polish/<label>-NN-<name>.png
 *   dusk  sunset, then the cameras that matter after dark (and the back lane for the skunks)
 *   perf  the street's draw-call / triangle cost as a same-camera DELTA (town forced out vs in)
 *
 * Software GPU, ~3 fps: every wait is generous, nothing here makes a frame-rate claim.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SX, SZ } from './marina.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5394';
const label = process.argv[2] || 'run';
const which = process.argv[3] || 'all';
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

const shot = async (name) => {
  for (let i = 0; i < 3; i++) {
    try { await page.screenshot({ path: path.join(OUT, `${label}-${name}.png`), timeout: 120000 }); console.log('shot', name); return; } catch (e) { await sleep(3000); }
  }
  errs.push('could not capture ' + name);
};
const place = async (s, wait = 5000) => {
  await page.evaluate(({ x, z, yaw, pitch }) => { window.__landDebug.place(x, z, yaw); window.__landDebug.look(yaw, pitch); }, { x: s.at[0], z: s.at[1], yaw: s.yaw, pitch: s.pitch });
  await sleep(wait);
};
const stats = () => page.evaluate(() => window.__landDebug.town());

await page.keyboard.press('KeyP'); // profiler HUD
await page.addStyleTag({ content: '#hud,#tags,#toast{display:none!important}' });
const SPOTS = {
  '10-promenade': { at: W(0, 22), yaw: 0, pitch: -0.05 },
  '11-harbor-drive': { at: W(0, 36), yaw: Math.PI / 2 + 0.3, pitch: 0 },
  '12-diner-and-tackle': { at: W(-20, 36), yaw: 0.35, pitch: 0.05 },
  '13-diner-signs-close': { at: W(-20, 43.5), yaw: 0, pitch: 0.12 },
  '14-bar-and-club': { at: W(35, 36), yaw: -0.25, pitch: 0.05 },
  '15-sombrero-blvd': { at: W(0, 90), yaw: -Math.PI / 2 - 0.2, pitch: 0.05 },
  '16-row2-fronts': { at: W(-40, 90), yaw: 0, pitch: 0.05 },
  '19-row1-rears': { at: W(-40, 90), yaw: Math.PI, pitch: 0.03 },
  '20-alley': { at: W(-37, 96), yaw: 0.1, pitch: 0.12 },
  '21-bench-promenade': { at: W(-60, 27), yaw: Math.PI, pitch: -0.02 },
  '17-back-lane': { at: W(-18, 75.5), yaw: -Math.PI / 2 + 0.25, pitch: -0.02 },
  '18-back-lot': { at: W(0, 128), yaw: Math.PI, pitch: -0.1 },
};
const DUSK = ['10-promenade', '11-harbor-drive', '14-bar-and-club', '17-back-lane'];

async function ashore() {
  await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, Math.PI), { x: SX, z: SZ + 55 });
  await sleep(3000);
  await page.keyboard.press('KeyF'); await sleep(3000);
  await page.evaluate(() => window.__landDebug.ensureBuilt());
}

if (which === 'day' || which === 'all') {
  await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: SX + 20, z: SZ + 110 });
  await sleep(5000);
  await shot('01-skyline-from-the-water');
  await ashore();
  const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
  for (const [name, s] of Object.entries(SPOTS)) { if (ONLY && !ONLY.some((o) => name.startsWith(o))) continue; await place(s, 4500); await shot(name); }
}

if (which === 'perf' || which === 'all') {
  if (which === 'perf') await ashore();
  const calls = () => page.evaluate(() => { const t = document.getElementById('profilerHud')?.textContent || ''; return { calls: +(t.match(/draw calls\s+(\d+)/) || [])[1], tris: +((t.match(/triangles\s+([\d.]+)k/) || [])[1] || 0) * 1000 }; });
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const rows = [];
  const measure = async (name, s) => {
    await place(s, 6000);
    const on = [], offv = [], onT = [], offT = [];
    for (let k = 0; k < 3; k++) {
      await page.evaluate(() => window.__landDebug.hideTown(false)); await sleep(3500);
      const a = await calls(); on.push(a.calls); onT.push(a.tris);
      await page.evaluate(() => window.__landDebug.hideTown(true)); await sleep(3500);
      const b = await calls(); offv.push(b.calls); offT.push(b.tris);
    }
    await page.evaluate(() => window.__landDebug.hideTown(false));
    const row = { label, name, deltaCalls: median(on) - median(offv), deltaTris: median(onT) - median(offT), on, off: offv, onT, offT };
    rows.push(row); console.log(JSON.stringify(row));
  };
  await measure('street-harbor-drive', SPOTS['11-harbor-drive']);
  await measure('street-sombrero', SPOTS['15-sombrero-blvd']);
  await measure('back-lane', SPOTS['17-back-lane']);
  fs.writeFileSync(path.join(OUT, `${label}-perf-day.json`), JSON.stringify(rows, null, 2));
}

if (which === 'dusk' || which === 'all') {
  if (which === 'dusk') await ashore();
  await page.keyboard.press('KeyO');
  await sleep(100000);
  for (const name of DUSK) { await place(SPOTS[name], 5000); await shot('dusk-' + name); }
  console.log(JSON.stringify((await stats()).lights.map((l) => [l.visible, l.intensity, l.kind])));
}

await browser.close();
console.log('errors:', errs.length); errs.slice(0, 10).forEach((e) => console.log('  ', e.slice(0, 300)));
