/**
 * The Gaff & Gill Casino, in the real game, by Playwright.
 *
 * Usage:  CLIENT_URL=http://localhost:5291 node test/capture-casino.mjs [shots|spin|perf]
 *
 *   shots  the street approach, the door, the floor, the cage, the fountain, the people — by day and after dark.
 *   spin   a machine mid-spin, a near-miss tease, a small win, a big win and the marlin; the paytable.
 *          Uses the real F key to open the panel and the real Space key to spin, and `__casinoDebug.seek`
 *          (verification only) to land on a win without burning thousands of spins.
 *   perf   draw calls and triangles with the casino forced out vs. in: at sea, in the street, at its door
 *          and on the floor — the same camera, the town hidden/shown, so the figure is a DELTA.
 *
 * Software GPU, ~3 fps: nothing here makes a frame-rate claim; everything waits generously and the
 * reel animation is measured in SIMULATED seconds (dt clamped to 0.05 per rendered frame).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5291';
const OUT = path.join(HERE, 'screenshots', 'casino');
fs.mkdirSync(OUT, { recursive: true });
const which = process.argv[2] || 'shots';

const SX = -900, SZ = 250.7;
const W = (u, v) => [SX + u, SZ - v];
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
const shot = async (page, name) => {
  for (let i = 0; i < 3; i++) {
    try { await page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 120000 }); console.log('shot', name); return; } catch (e) { console.log('retry', name, String(e).slice(0, 80)); await sleep(3000); }
  }
  errs.push('could not capture ' + name);
};
async function tieUp(page) {
  await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, Math.PI), { x: SX, z: SZ + 55 });
  await sleep(2500);
  await page.keyboard.press('KeyF');
  await sleep(2500);
}
const place = async (page, at, yaw, pitch = 0) => {
  const ok = await page.evaluate(({ x, z, yaw, pitch }) => { const k = window.__landDebug.place(x, z, yaw); window.__landDebug.look(yaw, pitch); return k; }, { x: at[0], z: at[1], yaw, pitch });
  if (!ok) console.log('could not place at', at);
};
const hideHud = (page, hide) => page.evaluate((h) => { for (const id of ['landHud']) document.getElementById(id)?.classList.toggle('hidden', h); }, hide);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180000);
await boot(page);
await page.keyboard.press('KeyP');

if (which === 'shots') {
  await tieUp(page);
  await page.evaluate(() => window.__landDebug.view('first'));
  await page.evaluate(() => window.__landDebug.ensureBuilt());
  // yaw convention (walker): 0 looks inland (+v), +PI/2 looks west (-u), -PI/2 east (+u), PI toward the sea
  const IN = 0, WEST = Math.PI / 2, EAST = -Math.PI / 2;
  const spots = {
    '01-palm-avenue-looking-inland': { at: W(0, 60), yaw: IN, pitch: 0.12 },
    '02-back-lot-approach': { at: W(0, 118), yaw: IN, pitch: 0.2 },
    '03-door-from-the-carpet': { at: W(0, 132), yaw: IN, pitch: 0.28 },
    '04-doorway': { at: W(0, 138.2), yaw: IN, pitch: 0.02 },
    '05-floor-from-the-entrance': { at: W(0, 142), yaw: IN, pitch: 0.0 },
    '06-floor-west-island': { at: W(-3, 148), yaw: IN + 0.7, pitch: -0.02 },
    '07-floor-east-and-cage': { at: W(2, 146), yaw: IN - 0.8, pitch: -0.02 },
    '08-fountain': { at: W(0, 150), yaw: IN, pitch: 0.1 },
    '09-back-bank': { at: W(0, 161.5), yaw: IN, pitch: 0.12 },
    '10-go-fish-table': { at: W(-10, 146), yaw: WEST, pitch: -0.05 },
    '11-change-booth': { at: W(12, 147), yaw: EAST, pitch: 0 },
    '12-mascot': { at: W(3.4, 141.2), yaw: IN, pitch: 0.05 },
    '13-pit-boss': { at: W(3.8, 150.6), yaw: IN, pitch: 0.05 },
    '14-cashier': { at: W(13.2, 146.2), yaw: EAST, pitch: 0.05 },
    '15-dealer': { at: W(-19, 152.2), yaw: Math.PI, pitch: 0.02 },
    '16-punter': { at: W(-17.6, 151.2), yaw: EAST, pitch: 0.0 },
  };
  const only = (process.env.ONLY || '').split(',').filter(Boolean);
  for (const [name, s] of Object.entries(spots)) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    await place(page, s.at, s.yaw, s.pitch);
    await sleep(4500);
    await shot(page, name);
  }
  // after dark
  await page.evaluate(() => window.__todDebug?.setSunset?.(1));
  console.log('errors', errs.length ? errs : 'none');
}

if (which === 'spin') {
  await tieUp(page);
  await page.evaluate(() => window.__landDebug.view('first'));
  await page.evaluate(() => window.__landDebug.ensureBuilt());
  // give the wallet something to play with
  await page.evaluate(() => window.__shopDebug.grant(5000));
  const at = await page.evaluate(() => window.__landDebug.interactWorld('slot-8'));
  await place(page, at, 0, 0.0); // a front-row island cabinet faces the door (-v): stand in front and look inland at it
  await sleep(4000);
  await shot(page, '20-at-the-machine');
  await page.keyboard.press('KeyF');
  await sleep(1500);
  await shot(page, '21-panel-idle');
  // a plain loser first, to see the mid-spin frames
  await page.evaluate(() => { window.__casinoDebug.seek('none'); window.__casinoDebug.resetGap(); });
  await page.keyboard.press('Space');
  for (let i = 0; i < 4; i++) { await sleep(900); }
  await shot(page, '22-mid-spin');
  await page.evaluate(() => window.__casinoDebug.advance(1.0));
  await shot(page, '23-stopping');
  await page.evaluate(() => window.__casinoDebug.advance(4));
  await shot(page, '24-loss');
  for (const kind of ['small', 'big', 'jackpot']) {
    await page.evaluate((k) => { window.__casinoDebug.seek(k); window.__casinoDebug.resetGap(); }, kind);
    await page.keyboard.press('Space');
    await sleep(600);
    await page.evaluate(() => window.__casinoDebug.advance(6.5));
    await page.evaluate(() => window.__casinoDebug.advance(0.8));
    await shot(page, `25-win-${kind}`);
  }
  await page.getByText('Paytable').click();
  await sleep(600);
  await shot(page, '29-paytable');
  await page.keyboard.press('Escape');
  await sleep(600);
  const cage = await page.evaluate(() => window.__landDebug.interactWorld('cage-casino'));
  await place(page, cage, -Math.PI / 2, 0);
  await sleep(3000);
  await page.keyboard.press('KeyF');
  await sleep(1500);
  await shot(page, '30-change-booth');
  console.log('state', JSON.stringify(await page.evaluate(() => window.__casinoDebug.state())));
  console.log('errors', errs.length ? errs : 'none');
}

if (which === 'perf') {
  // The casino's cost as a DELTA: the same camera, the same frame budget, the casino's interior forced out of the render
  // (`__landDebug.hideInterior('casino')`) vs. left in, and the whole town out for context. Median of three on/off pairs,
  // because one profiler sample is one frame and a frame can land mid-way through a reef chunk streaming in.
  await sleep(500);
  const calls = async () => page.evaluate(() => { const t = document.getElementById('profilerHud')?.textContent || ''; return { calls: +(t.match(/draw calls\s+(\d+)/) || [])[1], tris: +((t.match(/triangles\s+([\d.]+)k/) || [])[1] || 0) * 1000 }; });
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const rows = [];
  const st = () => page.evaluate(() => ({ town: window.__landDebug.town(), programs: window.__renderer.info.programs.length, geoms: window.__renderer.info.memory.geometries, tex: window.__renderer.info.memory.textures }));
  const delta = async (setHidden) => {
    const on = [], off = [], onT = [], offT = [];
    for (let k = 0; k < 3; k++) {
      await page.evaluate(setHidden, false); await sleep(3500); const a = await calls(); on.push(a.calls); onT.push(a.tris);
      await page.evaluate(setHidden, true); await sleep(3500); const b = await calls(); off.push(b.calls); offT.push(b.tris);
    }
    await page.evaluate(setHidden, false);
    return { calls: median(on) - median(off), tris: median(onT) - median(offT), on, off };
  };
  const row = async (label, at, yaw, pitch) => {
    await place(page, at, yaw, pitch); await sleep(6000);
    const s0 = await st();
    const room = await delta((h) => window.__landDebug.hideInterior('casino', h));
    const town = await delta((h) => window.__landDebug.hideTown(h));
    const r = { label, casinoInteriorDeltaCalls: room.calls, casinoInteriorDeltaTris: room.tris, wholeTownDeltaCalls: town.calls, wholeTownDeltaTris: town.tris, lights: s0.town.lights.filter((l) => l.visible).length, lightsActive: s0.town.lightsActive, programs: s0.programs, geometries: s0.geoms, textures: s0.tex, interiorsVisible: s0.town.interiorsVisible, samples: { room, town: { on: town.on, off: town.off } } };
    rows.push(r); console.log(JSON.stringify(r));
  };
  // before anything is near: nothing built (lazy), and what the town costs at 2.3 km is the town's own harness's business
  console.log('built before approach', JSON.stringify((await st()).town.interiorsBuilt));
  await tieUp(page);
  await page.evaluate(() => window.__landDebug.view('first'));
  const IN = 0, WEST = Math.PI / 2, EAST = -Math.PI / 2;
  await row('street, 60 m from the casino, facing it (day)', W(0, 80), IN, 0.2);
  console.log('built after approach', JSON.stringify((await st()).town.interiorsBuilt), 'build ms', JSON.stringify((await st()).town.interiorBuildMs));
  await row('at the door, 3 m out (day)', W(0, 137), IN, 0.1);
  await row('on the floor looking down the aisle (day)', W(0, 142), IN, 0.0);
  await row('on the floor facing the west island (day)', W(-3, 148), IN + 1.0, -0.02);
  await row('on the floor facing a bare wall (day)', W(0, 143), WEST + 0.3, 0.0);
  await row('on the floor at the machines, crowd in view (day)', W(-12, 156), IN, 0.0);
  await page.keyboard.press('KeyO'); // sunset (the toggle #btnSun hides ashore)
  await sleep(100000);
  await row('on the floor looking down the aisle, SUNSET (lights pool live)', W(0, 142), IN, 0.0);
  fs.writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify(rows, null, 2));
}

await browser.close();
if (errs.length) { console.log('ERRORS\n' + errs.join('\n')); process.exitCode = 1; }
