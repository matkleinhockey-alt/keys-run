/**
 * The casino's aquarium wall and its walking fish mascot, in the real game, by Playwright.
 *
 * Usage:  CLIENT_URL=http://localhost:5471 node test/capture-casino-aquarium.mjs [shots|cost]
 *
 *   shots  the tank from the aisle, from the glass, down its length; the mascot from the door, in
 *          close, side-on and from behind. Pairs of frames seconds apart, so a still can show that
 *          the fish moved and the mascot walked rather than claiming it.
 *   cost   draw calls and triangles with the tank's three animated meshes toggled off and on
 *          (`aquarium-fish`, `aquarium-tails`, `aquarium-glass`), from the one camera that frames
 *          all of them. Everything else the tank is made of lives in the interior's existing
 *          `solid`/`neon`/`glow` batches and so cannot be measured as a delta — it is zero by
 *          construction; the triangle count it adds to those batches is printed instead.
 *
 * Same harness as capture-casino.mjs (`.krAuthOffline` + `#btnGo`, `__fishDebug.teleport` to the
 * dock, F to tie up, `__landDebug.place/look/ensureBuilt`). Software GPU, ~3 fps: nothing here makes
 * a frame-rate claim, and every move waits generously.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SX, SZ } from './marina.mjs';
import { CLIENT_URL } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = CLIENT_URL;
const OUT = path.join(HERE, 'screenshots', 'casino-aquarium');
fs.mkdirSync(OUT, { recursive: true });
const which = process.argv[2] || 'shots';

// Imported, not copied: this pair went stale once already — see test/marina.mjs.
// (SX/SZ keep their names so the rest of each script is untouched.)
const W = (u, v) => [SX + u, SZ - v];
const IN = 0, WEST = Math.PI / 2, EAST = -Math.PI / 2, OUT_ = Math.PI;
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
/**
 * Verification-only: the game exposes no scene handle, so borrow the one the renderer is handed.
 * The postprocessing composer renders several scenes per frame and the LAST is the full-screen quad
 * the final EffectPass blits, so keep the fattest one rather than the most recent.
 */
const grabScene = (page) => page.evaluate(() => {
  const r = window.__renderer, orig = r.render.bind(r);
  r.render = (scene, cam) => {
    if (scene.children.length > 10) window.__sceneRef = scene;
    orig(scene, cam);
  };
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.setDefaultTimeout(180000);
await boot(page);
await page.keyboard.press('KeyP');
await tieUp(page);
await page.evaluate(() => window.__landDebug.view('first'));
await page.evaluate(() => window.__landDebug.ensureBuilt());

if (which === 'shots') {
  // The tank is on the west wall, v 148.6..155 — the gap between the Go Fish table and the west bank.
  const spots = {
    '01-from-the-entrance': { at: W(-6, 145), yaw: WEST - 0.55, pitch: 0.06 },
    '02-across-the-aisle': { at: W(-17, 151.8), yaw: WEST, pitch: 0.06 },
    '03-at-the-glass': { at: W(-20.6, 151.8), yaw: WEST, pitch: 0.04 },
    '04-down-the-tank': { at: W(-20.4, 147.2), yaw: WEST - 0.85, pitch: 0.04 },
    '05-from-the-west-bank': { at: W(-20.4, 157.5), yaw: OUT_ - 0.5, pitch: 0.02 },
    '06-tank-and-the-room': { at: W(-10, 158), yaw: OUT_ + 0.9, pitch: 0.0 },
    '10-mascot-from-the-door': { at: W(1.2, 140.6), yaw: IN + 0.5, pitch: 0.1 },
    '11-mascot-head-on': { at: W(0.6, 140.6), yaw: IN - 0.62, pitch: 0.12 },
    '12-mascot-side-on': { at: W(8.5, 143.4), yaw: WEST, pitch: 0.06 },
    '13-mascot-from-behind': { at: W(3.4, 147.0), yaw: OUT_, pitch: 0.06 },
    '14-mascot-close': { at: W(3.4, 141.0), yaw: IN, pitch: 0.18 },
    '15-mascot-three-quarter': { at: W(6.8, 140.9), yaw: IN + 0.75, pitch: 0.08 },
  };
  const only = (process.env.ONLY || '').split(',').filter(Boolean);
  for (const [name, s] of Object.entries(spots)) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    await place(page, s.at, s.yaw, s.pitch);
    await sleep(4500);
    // Four frames a quarter of the mascot's 14 s beat apart, from the one camera: the fish should be
    // somewhere else each time, and two of the four catch the mascot at an end of his beat, which is
    // where he turns to face the door. (Even spacing is the only handle there is — the game exposes
    // no clock hook, and at ~2 fps the screenshot itself costs a second of it.)
    for (const suffix of ['', '-b', '-c', '-d']) {
      await shot(page, name + suffix);
      if (suffix !== '-d') await sleep(2600);
    }
  }
  console.log('errors', errs.length ? errs : 'none');
}

if (which === 'cost') {
  await grabScene(page);
  await place(page, W(-18, 151.8), WEST, 0.05);
  // 30 s, not 6: the first run's draw-call samples climbed 228 -> 263 across the measurement because
  // reef chunks were still streaming in, which is many times the delta being measured
  await sleep(30000);
  const hud = () => page.evaluate(() => { const t = document.getElementById('profilerHud')?.textContent || ''; return { calls: +(t.match(/draw calls\s+(\d+)/) || [])[1], tris: +((t.match(/triangles\s+([\d.]+)k/) || [])[1] || 0) * 1000 }; });
  const setVis = (v) => page.evaluate((vis) => {
    let n = 0;
    window.__sceneRef.traverse((o) => { if (/^aquarium-/.test(o.name)) { o.visible = vis; n++; } });
    return n;
  }, v);
  const found = await setVis(true);
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const on = [], off = [], onT = [], offT = [];
  for (let k = 0; k < 5; k++) {
    await setVis(true); await sleep(2500); const a = await hud(); on.push(a.calls); onT.push(a.tris);
    await setVis(false); await sleep(2500); const b = await hud(); off.push(b.calls); offT.push(b.tris);
  }
  await setVis(true);
  // what the tank poured into the interior's shared batches: counted by rebuilding it against a
  // throwaway batch in the page, which is the only honest way to separate it from 30 slot cabinets
  const batched = await page.evaluate(async () => {
    const [{ GeoBatch }, { buildAquarium }] = await Promise.all([
      import('/src/entities/town/batch.ts'),
      import('/src/entities/town/casino-aquarium.ts'),
    ]);
    const THREE = await import('/node_modules/three/build/three.module.js').catch(() => null);
    const s = new GeoBatch(false, 2.0), n = new GeoBatch(false, 1), g = new GeoBatch(true);
    const holder = { add: () => {}, children: [] };
    const a = buildAquarium(holder, { u0: -23.6, u1: -22.2, v0: 148.6, v1: 155 }, 1.84, s, n, g);
    const out = { solid: s.triangleCount, neon: n.triangleCount, glow: g.triangleCount, fishTris: a.tris };
    a.dispose();
    void THREE;
    return out;
  });
  const row = {
    namedMeshesFound: found,
    animatedDeltaCalls: median(on) - median(off),
    animatedDeltaTris: median(onT) - median(offT),
    batchedTriangles: batched,
    samples: { on, off, onT, offT },
  };
  console.log(JSON.stringify(row, null, 2));
  fs.writeFileSync(path.join(OUT, 'cost.json'), JSON.stringify(row, null, 2));
  console.log('errors', errs.length ? errs : 'none');
}

await browser.close();
if (errs.length) { console.log('ERRORS\n' + errs.join('\n')); process.exitCode = 1; }
