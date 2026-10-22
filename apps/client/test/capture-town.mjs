/**
 * Boot Key Harbor City, in the real game, by Playwright.
 *
 * Usage:  CLIENT_URL=http://localhost:5191 node test/capture-town.mjs [shots|night|modes|perf]
 *
 *   shots  walk the town (teleporting the walker, never faking the mode) and save screenshots to
 *          test/screenshots/town/ — every venue by day, the venue panels, the two interiors.
 *   night  sunset from the water, then the street, the neon and both interiors after dark.
 *   modes  boat -> land -> boat and boat -> diver -> boat, repeated, asserting after each leg that
 *          the camera planes, HUD, input bindings and boat state came back (see `assertBoatNormal`).
 *   perf   the town's cost as a draw-call DELTA (same camera, town forced out vs. in) at sea, in the
 *          harbour, in the street and in the bar — the "costs nothing at sea" claim, measured.
 *
 * This sandbox renders ~3 fps on a software GPU, so every wait is generous and nothing here makes
 * a frame-rate claim. `window.__landDebug` / `window.__fishDebug` are verification hooks only.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5191';
const OUT = path.join(HERE, 'screenshots', 'town');
fs.mkdirSync(OUT, { recursive: true });
const which = process.argv[2] || 'shots';

// Boot Key Harbor City Marina (world/depth.ts MARINAS[0]): sx -900, shoreline sz ~250.7, dir +1
// (sea at +z, land at -z). Local (u, v) -> world: x = sx + u, z = sz - v.
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
  // The software GPU can starve the page long enough for Playwright's "wait for fonts" to time out; retry rather than lose a run.
  for (let i = 0; i < 3; i++) {
    try { await page.screenshot({ path: path.join(OUT, name + '.png'), timeout: 120000 }); console.log('shot', name); return; } catch (e) { console.log('retry', name, String(e).slice(0, 80)); await sleep(3000); }
  }
  errs.push('could not capture ' + name);
};
const evalL = (page, fn, arg) => page.evaluate(fn, arg);

/** Pull the boat alongside the T-head of the marina and step ashore with the real F key. */
async function tieUpAtTownDock(page) {
  const [x, z] = [SX, SZ + 55];
  await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, Math.PI), { x, z });
  await sleep(2500); // let the town stage in and the dock prompt appear
  await page.keyboard.press('KeyF');
  await sleep(2500);
}

async function stats(page) {
  return page.evaluate(() => ({ land: window.__landDebug.state(), town: window.__landDebug.town() }));
}

/** The boat-mode invariants that a stuck mode transition breaks. */
async function assertBoatNormal(page, label) {
  const r = await page.evaluate(() => {
    const hidden = (id) => document.getElementById(id)?.classList.contains('hidden');
    const cam = window.__fishDebug.boatState();
    return {
      landMode: window.__landDebug.mode(), diverMode: window.__diverDebug.mode(),
      gauges: !hidden('gauges'), mapbox: !hidden('mapbox'), scorebox: !hidden('scorebox'),
      landHud: !hidden('landHud'), diverHud: !hidden('diverHud'), dockPromptVisible: !hidden('dockPrompt'), hint: !hidden('hint'),
      boat: cam,
    };
  });
  const bad = [];
  if (r.landMode !== 'boat') bad.push('land mode stuck: ' + r.landMode);
  if (r.diverMode !== 'boat') bad.push('diver mode stuck: ' + r.diverMode);
  if (!r.gauges || !r.mapbox || !r.scorebox) bad.push('boat HUD not restored ' + JSON.stringify(r));
  if (!r.hint) bad.push('driving hint not restored');
  if (r.landHud) bad.push('land HUD still showing');
  if (r.diverHud) bad.push('diver HUD still showing');
  console.log(label, bad.length ? 'FAIL ' + bad.join('; ') : 'ok', JSON.stringify(r.boat));
  if (bad.length) { errs.push(`${label}: ${bad.join('; ')}`); }
  return r;
}

const camNow = (page) => page.evaluate(() => ({ cam: window.__landDebug.camera(), boatCam: window.__landDebug.boatCam(), boat: window.__fishDebug.boatState() }));

async function holdKey(page, code, ms) {
  await page.keyboard.down(code); await sleep(ms); await page.keyboard.up(code);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
// The box is shared and the GPU is software: give every action room rather than flake.
page.setDefaultTimeout(180000);
await boot(page);

if (which === 'shots') {
  await page.keyboard.press('KeyP');
  await shot(page, '00-spawn');
  // a skyline approach shot from the water, before it is walkable
  await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: SX + 20, z: SZ + 110 });
  await sleep(4000);
  await shot(page, '01-from-the-harbour');
  await tieUpAtTownDock(page);
  console.log(JSON.stringify(await stats(page)));
  await shot(page, '02-on-the-dock');
  await page.evaluate(() => window.__landDebug.view('third'));
  await sleep(2500);
  await shot(page, '03-third-person-dock');
  await page.evaluate(() => window.__landDebug.view('first'));
  const spots = {
    '10-promenade': { at: W(0, 22), yaw: 0, pitch: -0.05 },
    '11-harbor-drive': { at: W(0, 36), yaw: Math.PI / 2 + 0.3, pitch: 0 },
    '12-diner-and-tackle': { at: W(-20, 36), yaw: 0.35, pitch: 0.05 },
    '13-gun-shop': { at: W(-72, 40), yaw: 0, pitch: 0.02 },
    '14-bar-and-club': { at: W(35, 36), yaw: -0.25, pitch: 0.05 },
    '15-strip-club-door': { at: W(44, 41), yaw: 0, pitch: 0.05 },
    '16-sombrero-blvd': { at: W(0, 90), yaw: -Math.PI / 2 - 0.2, pitch: 0.05 },
    '17-back-lot': { at: W(0, 128), yaw: Math.PI, pitch: -0.1 },
  };
  for (const [name, s] of Object.entries(spots)) {
    const ok = await page.evaluate(({ x, z, yaw, pitch }) => { const k = window.__landDebug.place(x, z, yaw); window.__landDebug.look(yaw, pitch); return k; }, { x: s.at[0], z: s.at[1], yaw: s.yaw, pitch: s.pitch });
    if (!ok) console.log('could not place at', name);
    await sleep(3500);
    await shot(page, name);
  }
  // venue panels: walk to each door, read the prompt, press the real F key
  for (const [name, id, yaw] of [['30-panel-guns', 'door-guns', 0], ['31-panel-club', 'door-club', 0], ['32-panel-tackle', 'door-tackle', 0], ['33-panel-bar-counter', 'counter-bar', 0]]) {
    const at = await page.evaluate((id) => window.__landDebug.interactWorld(id), id);
    await page.evaluate(({ x, z, yaw }) => { window.__landDebug.place(x, z, yaw); window.__landDebug.look(yaw, -0.05); }, { x: at[0], z: at[1], yaw });
    await sleep(3000);
    const prompt = await page.evaluate(() => document.getElementById('landPrompt').textContent);
    console.log(id, 'prompt:', JSON.stringify(prompt));
    if (!prompt) errs.push('no prompt at ' + id);
    await page.keyboard.press('KeyF'); await sleep(2500);
    const open = await page.evaluate(() => !document.getElementById('landPanel').classList.contains('hidden'));
    if (!open) errs.push('panel did not open at ' + id);
    await shot(page, name);
    await page.keyboard.press('Escape'); await sleep(800);
    const closed = await page.evaluate(() => document.getElementById('landPanel').classList.contains('hidden'));
    if (!closed) errs.push('panel did not close at ' + id);
  }
  for (const [name, at, yaw] of [['18-inside-the-bar', W(21, 51), 0.0], ['19-inside-the-diner', W(-20, 51), 0.0]]) {
    await page.evaluate(({ x, z, yaw }) => { window.__landDebug.place(x, z, yaw); window.__landDebug.look(yaw, -0.08); }, { x: at[0], z: at[1], yaw });
    await sleep(4000);
    await shot(page, name);
  }
  // sunset: the sky blend advances dt/3 per SIM second and the sim is clamped to 50 ms a frame, so at
  // this sandbox's frame rate it takes about a minute and a half of wall clock to finish.
  if (!process.env.SKIP_NIGHT) {
  await page.keyboard.press('KeyO'); // #btnSun lives in the boat HUD, hidden ashore; O is the same toggle
  await sleep(100000);
  for (const [name, s] of Object.entries({
    '20-night-promenade': spots['10-promenade'], '21-night-bar-club': spots['14-bar-and-club'], '22-night-harbor-drive': spots['11-harbor-drive'], '23-night-club-door': spots['15-strip-club-door'],
  })) {
    await page.evaluate(({ x, z, yaw, pitch }) => { window.__landDebug.place(x, z, yaw); window.__landDebug.look(yaw, pitch); }, { x: s.at[0], z: s.at[1], yaw: s.yaw, pitch: s.pitch });
    await sleep(3500);
    await shot(page, name);
  }
  console.log(JSON.stringify((await stats(page)).town.lights));
  }
}

if (which === 'night') {
  // sunset first, from the water, so the skyline shot is the town glowing from a boat
  await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: SX + 20, z: SZ + 140 });
  await page.keyboard.press('KeyO');
  await sleep(100000);
  await page.addStyleTag({ content: '#hud,#tags{display:none!important}' });
  await sleep(3000);
  await shot(page, '40-night-skyline-from-the-water');
  await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: SX + 5, z: SZ + 60 });
  await sleep(5000);
  await shot(page, '41-night-approach');
  await page.addStyleTag({ content: '#hud,#tags{display:block!important}' });
  await tieUpAtTownDock(page);
  const spots = {
    '42-night-promenade': { at: W(0, 22), yaw: 0, pitch: -0.02 },
    '43-night-harbor-drive': { at: W(0, 36), yaw: Math.PI / 2 + 0.3, pitch: 0 },
    '44-night-bar-and-club': { at: W(35, 36), yaw: -0.25, pitch: 0.05 },
    '45-night-club-door': { at: W(44, 41), yaw: 0, pitch: 0.05 },
    '46-night-diner': { at: W(-20, 38), yaw: 0.2, pitch: 0.05 },
    '47-night-sombrero-blvd': { at: W(0, 90), yaw: -Math.PI / 2 - 0.2, pitch: 0.05 },
    '48-night-inside-the-bar': { at: W(21, 51), yaw: 0, pitch: -0.08 },
    '49-night-inside-the-diner': { at: W(-20, 51), yaw: 0, pitch: -0.08 },
  };
  for (const [name, s] of Object.entries(spots)) {
    await page.evaluate(({ x, z, yaw, pitch }) => { window.__landDebug.place(x, z, yaw); window.__landDebug.look(yaw, pitch); }, { x: s.at[0], z: s.at[1], yaw: s.yaw, pitch: s.pitch });
    await sleep(6000);
    await shot(page, name);
    console.log(name, JSON.stringify((await stats(page)).town.lights.map((l) => [l.visible, l.intensity, l.kind])));
  }
  // third person at the club door: the player's own body under the neon
  await page.evaluate(({ x, z }) => { window.__landDebug.place(x, z, 0); window.__landDebug.view('third'); window.__landDebug.look(0.5, -0.12); }, { x: W(44, 41)[0], z: W(44, 41)[1] });
  await sleep(6000);
  await shot(page, '50-night-third-person-club');
}

if (which === 'modes') {
  const TOPSIDE = await camNow(page);
  console.log('baseline', JSON.stringify(TOPSIDE.cam), JSON.stringify(TOPSIDE.boatCam));
  await assertBoatNormal(page, 'baseline');
  const sameCam = (a, b, label) => {
    const bad = [];
    if (a.cam.near !== b.cam.near || a.cam.far !== b.cam.far) bad.push(`near/far ${a.cam.near}/${a.cam.far} vs ${b.cam.near}/${b.cam.far}`);
    for (const k of Object.keys(a.boatCam)) if (a.boatCam[k] !== b.boatCam[k]) bad.push(`boatCam.${k} ${a.boatCam[k]} -> ${b.boatCam[k]}`);
    console.log(label, bad.length ? 'FAIL ' + bad.join('; ') : 'camera + boat-cam state restored');
    if (bad.length) errs.push(`${label}: ${bad.join('; ')}`);
  };

  for (let round = 1; round <= 3; round++) {
    console.log(`--- round ${round}: boat -> land -> boat`);
    // drag the boat camera around first, so there is something to snapshot and restore
    await page.mouse.move(600, 400); await page.mouse.down(); await page.mouse.move(520 + round * 30, 380); await page.mouse.up();
    await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, Math.PI), { x: SX, z: SZ + 55 });
    await sleep(2500);
    const before = await camNow(page);
    const dockPrompt = await page.evaluate(() => !document.getElementById('dockPrompt').classList.contains('hidden'));
    console.log('dock prompt shown beside the dock:', dockPrompt);
    if (!dockPrompt) errs.push('dock prompt not shown');
    await page.keyboard.press('KeyF'); await sleep(2500);
    const inLand = await page.evaluate(() => ({
      mode: window.__landDebug.mode(), gauges: !document.getElementById('gauges').classList.contains('hidden'),
      landHud: !document.getElementById('landHud').classList.contains('hidden'),
      cam: window.__landDebug.camera(),
    }));
    console.log('ashore:', JSON.stringify(inLand));
    if (inLand.mode !== 'land' || inLand.gauges || !inLand.landHud || inLand.cam.near !== 0.08) errs.push('bad land state ' + JSON.stringify(inLand));
    // hold W: must walk the walker and must NOT move the boat
    const p0 = await page.evaluate(() => window.__landDebug.state().player);
    await holdKey(page, 'KeyW', 2500);
    const p1 = await page.evaluate(() => window.__landDebug.state().player);
    const boatMid = await page.evaluate(() => window.__fishDebug.boatState());
    console.log('walked', Math.hypot(p1.x - p0.x, p1.z - p0.z).toFixed(2), 'm; boat moved', Math.hypot(boatMid.x - before.boat.x, boatMid.z - before.boat.z).toFixed(2), 'm, speed', boatMid.speed.toFixed(2));
    if (Math.hypot(p1.x - p0.x, p1.z - p0.z) < 0.1) errs.push('walker did not move');
    if (Math.hypot(boatMid.x - before.boat.x, boatMid.z - before.boat.z) > 0.5 || Math.abs(boatMid.speed) > 0.3) errs.push('boat drifted/accelerated while tied up');
    // Space (rod cast) and J (dive) must be inert ashore
    await holdKey(page, 'Space', 700);
    const cast = await page.evaluate(() => !document.getElementById('castbar').classList.contains('hidden'));
    await page.keyboard.press('KeyJ'); await sleep(1200);
    const afterJ = await page.evaluate(() => ({ land: window.__landDebug.mode(), diver: window.__diverDebug.mode() }));
    console.log('Space cast bar ashore:', cast, ' J ashore ->', JSON.stringify(afterJ));
    if (cast) errs.push('rod cast while ashore');
    if (afterJ.land !== 'land' || afterJ.diver !== 'boat') errs.push('J changed mode ashore');
    // far from the boat: B refuses, B twice cabs, B boards
    if (round === 2) {
      const far = W(95, 128);
      await page.evaluate(({ x, z }) => window.__landDebug.place(x, z, 0), { x: far[0], z: far[1] });
      await sleep(1000);
      await page.keyboard.press('KeyB'); await sleep(900);
      const still = await page.evaluate(() => window.__landDebug.mode());
      console.log('B far from the boat ->', still, '(expect land)');
      if (still !== 'land') errs.push('boarded from across town');
      await page.keyboard.press('KeyB'); await sleep(900);
      const cab = await page.evaluate(() => ({ mode: window.__landDebug.mode(), d: window.__landDebug.state().boardDistance }));
      console.log('B again ->', JSON.stringify(cab), '(expect land, back at the dock)');
      if (cab.mode !== 'land' || cab.d > 9) errs.push('cab did not return to dock ' + JSON.stringify(cab));
    } else {
      await page.evaluate(({ x, z }) => window.__landDebug.place(x, z, 0), { x: before.boat.x, z: SZ + 49 });
    }
    await page.keyboard.press('KeyB'); await sleep(2500);
    await assertBoatNormal(page, `round ${round} after boarding`);
    sameCam(before, await camNow(page), `round ${round}`);
    // controls are live again: W moves the boat
    await holdKey(page, 'KeyW', 3500);
    const sp = await page.evaluate(() => window.__fishDebug.boatState());
    console.log('after boarding, W gives the boat speed', sp.speed.toFixed(2));
    if (!(sp.speed > 0.2)) errs.push('boat throttle dead after boarding');
    await page.evaluate(() => window.__fishDebug.teleport(-900, 306 + 6, Math.PI));
    await sleep(1500);

    console.log(`--- round ${round}: boat -> diver -> boat`);
    const dBefore = await camNow(page);
    await page.keyboard.press('KeyJ'); await sleep(1800);
    const dv = await page.evaluate(() => ({ diver: window.__diverDebug.mode(), hud: !document.getElementById('diverHud').classList.contains('hidden') }));
    await page.keyboard.press('KeyF'); await sleep(900);
    const tiedFromWater = await page.evaluate(() => window.__landDebug.mode());
    console.log('diving:', JSON.stringify(dv), ' F while diving ->', tiedFromWater, '(expect boat)');
    if (dv.diver !== 'diver' || !dv.hud || tiedFromWater !== 'boat') errs.push('dive state wrong ' + JSON.stringify(dv) + tiedFromWater);
    await page.evaluate(() => { const s = window.__diverDebug.state(); const b = window.__fishDebug.boatState(); s.x = b.x + 2; s.z = b.z; s.y = -0.2; });
    await sleep(800);
    await page.keyboard.press('KeyJ'); await sleep(2500);
    await assertBoatNormal(page, `round ${round} after diving`);
    sameCam(dBefore, await camNow(page), `round ${round} (dive)`);
    await holdKey(page, 'KeyW', 3000);
    const sp2 = await page.evaluate(() => window.__fishDebug.boatState());
    if (!(sp2.speed > 0.2)) errs.push('boat throttle dead after diving');
    await page.evaluate(() => window.__fishDebug.teleport(-900, 306 + 6, Math.PI));
    await sleep(1200);
  }

  // The marina button while ashore (the involuntary path): must restore everything.
  console.log('--- involuntary exit: Switch boat while ashore');
  await page.evaluate(() => window.__fishDebug.teleport(-900, 306 + 6, Math.PI)); await sleep(2000);
  await page.keyboard.press('KeyF'); await sleep(2500);
  await page.evaluate(() => document.getElementById('btnMarina').click()); await sleep(2500);
  await page.click('#btnGo'); await sleep(2000);
  await assertBoatNormal(page, 'after Switch boat while ashore');
}

if (which === 'perf') {
  // What the town costs, as a DELTA: the same camera, the same frame budget, town forced out of the render
  // (`__landDebug.hideTown`) vs. left in. Absolute draw-call counts here are dominated by the sea, the reef
  // and the fish and swing by hundreds with where you look, so a bare number would prove nothing.
  await page.keyboard.press('KeyP'); await sleep(500);
  const calls = async () => page.evaluate(() => { const t = document.getElementById('profilerHud')?.textContent || ''; return { calls: +(t.match(/draw calls\s+(\d+)/) || [])[1], tris: +((t.match(/triangles\s+([\d.]+)k/) || [])[1] || 0) * 1000 }; });
  const programs = () => page.evaluate(() => window.__renderer.info.programs.length);
  const rows = [];
  const settle = async (pred, label) => {
    // the chase camera and the software renderer both lag the teleport by several frames
    for (let i = 0; i < 40; i++) { const st = (await stats(page)).town; if (pred(st)) return st; await sleep(2000); }
    errs.push('did not settle: ' + label); return (await stats(page)).town;
  };
  const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  // Three alternating on/off pairs, median of each: one profiler sample is one frame, and a frame at this
  // frame rate can land mid-way through a reef chunk streaming in (a single pair swung by hundreds).
  const measure = async (label, pred) => {
    await page.evaluate(() => window.__landDebug.hideTown(false));
    const st = await settle(pred, label);
    await sleep(6000);
    const live = (await stats(page)).town; // read before the first forced hide: a hide leaves `root.visible` false until the next frame
    Object.assign(st, { rootVisible: live.rootVisible, nearVisible: live.nearVisible, farVisible: live.farVisible, lightsActive: live.lightsActive, distance: live.distance });
    const on = [], off = [], onTris = [], offTris = [];
    for (let k = 0; k < 3; k++) {
      await page.evaluate(() => window.__landDebug.hideTown(false)); await sleep(3500);
      const a = await calls(); on.push(a.calls); onTris.push(a.tris);
      await page.evaluate(() => window.__landDebug.hideTown(true)); await sleep(3500);
      const b = await calls(); off.push(b.calls); offTris.push(b.tris);
    }
    await page.evaluate(() => window.__landDebug.hideTown(false));
    const row = { label, dist: st.distance, rootVisible: st.rootVisible, near: st.nearVisible, far: st.farVisible, lights: st.lightsActive, callsWithTown: median(on), callsWithout: median(off), deltaCalls: median(on) - median(off), deltaTris: median(onTris) - median(offTris), samplesOn: on, samplesOff: off, programs: await programs() };
    rows.push(row); console.log(JSON.stringify(row));
    return row;
  };
  const go = (x, z, h = 0) => page.evaluate(({ x, z, h }) => window.__fishDebug.teleport(x, z, h), { x, z, h });
  const chain = (x) => 0.000012 * x * x;
  const seaRows = [], farRows = [];
  await go(-900, chain(-900) + 2600); seaRows.push(await measure('offshore, 2.3 km out', (s) => s.distance > 1500 && !s.nearVisible && !s.farVisible));
  await go(-2800, chain(-2800) + 900); seaRows.push(await measure('west of the bridge, 2 km away', (s) => s.distance > 1500 && !s.farVisible));
  await go(-300, chain(-300) + 1200); farRows.push(await measure('Hawk Channel, 1 km out (far silhouette: 2 draw calls)', (s) => s.distance > 800 && s.distance < 1500 && s.farVisible));
  await go(-900, 306 + 220); farRows.push(await measure('harbour mouth, ~350 m (far silhouette)', (s) => s.distance > 300 && s.distance < 700 && s.farVisible));
  await go(-900, 306 + 90); await measure('approaching the dock, ~130 m off the seawall (near detail)', (s) => s.distance < 200 && s.nearVisible);
  await go(-900, 306);
  await page.keyboard.press('KeyF'); await sleep(3000);
  await page.evaluate(({ x, z }) => { window.__landDebug.place(x, z, 0); window.__landDebug.look(0, 0); }, { x: W(0, 36)[0], z: W(0, 36)[1] });
  await measure('in the street, day', (s) => s.distance === 0 && s.nearVisible);
  await page.evaluate(({ x, z, yaw }) => { window.__landDebug.place(x, z, yaw); window.__landDebug.look(yaw, -0.08); }, { x: W(21, 52)[0], z: W(21, 52)[1], yaw: 0 });
  await measure('inside the bar, day (the interior lamp is the only real light)', (s) => s.lightsActive && s.interiorsVisible.includes('bar'));
  await page.evaluate(({ x, z }) => { window.__landDebug.place(x, z, 0); window.__landDebug.look(0, 0); }, { x: W(0, 36)[0], z: W(0, 36)[1] });
  await page.keyboard.press('KeyO'); // sunset; #btnSun is hidden ashore, O is the same toggle
  await sleep(100000);
  await measure('in the street, sunset (four real lights)', (s) => s.lightsActive);
  await page.evaluate(() => window.__landDebug.place(-900, 299, 0)); await sleep(800);
  await page.keyboard.press('KeyB'); await sleep(3000);
  await go(-900, chain(-900) + 2600); seaRows.push(await measure('offshore again at sunset: the lights must be gone', (s) => s.distance > 1500 && !s.lightsActive));
  // Free at sea means: the root is not even visible (zero draws by construction) and the lights are off. Those
  // two are exact. The measured delta is printed beside them as a sanity check, not asserted: with the town
  // forced out, the same camera still shows the sea, reef and fish changing under it frame to frame, and at
  // the busiest pose that is worth tens of draw calls either way (it is negative as often as positive).
  const sea = seaRows.every((r) => !r.rootVisible && !r.lights);
  console.log('AT SEA: rootVisible', seaRows.map((r) => r.rootVisible).join(','), '| delta draw calls', seaRows.map((r) => r.deltaCalls).join(', '), '| lights', seaRows.map((r) => r.lights).join(','), sea ? '-> free' : '-> NOT FREE');
  if (!sea) errs.push('town is not free at sea');
  // the far silhouette is two draw calls by design; allow the same measurement noise
  const far = farRows.every((r) => !r.lights && r.deltaCalls <= 25);
  console.log('FAR SILHOUETTE: delta draw calls', farRows.map((r) => r.deltaCalls).join(', '), far ? '-> within budget' : '-> OVER BUDGET');
  if (!far) errs.push('far silhouette is not cheap');
  fs.writeFileSync(path.join(OUT, 'perf.json'), JSON.stringify(rows, null, 2));
}

await browser.close();
console.log('errors:', errs.length);
errs.slice(0, 20).forEach((e) => console.log('  ', e.slice(0, 300)));
process.exit(errs.length ? 1 : 0);
