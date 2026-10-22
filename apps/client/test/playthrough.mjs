/**
 * END-TO-END PLAYTHROUGH AGENT. Drives the real game in a real browser the way a player would
 * (start screen -> drive the boat -> cast -> strike -> fight -> land -> cooler/weigh-in -> dive ->
 * spearfish -> leaderboard -> race) and reports numbers about *progression*: how long until the
 * first catch, how often a fight is lost and why, how much variety turns up, how long a dive
 * lasts, what the speargun hits, and how long the player goes between anything new happening.
 *
 * Usage (dev server must be up: `pnpm --filter @keysrun/client dev --port 5191`):
 *   CLIENT_URL=http://localhost:5191 node apps/client/test/playthrough.mjs
 * Env: PT_ONLY=drive,reef,hawk,offshore,dive,meta (subset of sessions), PT_CASTS=n casts per
 *      fishing session (default 4), PT_SHOTS=n spear shots (default 9), PT_QUALITY=Low.
 * Output (PT_TAG suffixes the names): test/playthrough/report.json (structured) + test/playthrough/summary.txt (readable).
 *
 * ---- Read this before trusting any number ------------------------------------------------
 * 1. SIMULATED vs WALL time. This sandbox renders ~3 fps on a software GPU, and game/world.ts's
 *    `frame()` clamps each rendered frame to 0.05 s of simulated time, so simulated time runs
 *    several times slower than the wall clock. Every duration here is therefore reported in
 *    SIMULATED seconds (`sim`), integrated in-page from the same 0.05 s clamp, with wall seconds
 *    carried alongside only to show the slowdown ratio. Gameplay pacing claims use `sim`.
 *    Performance claims are deliberately NOT made anywhere.
 * 2. Sessions run as separate browser pages IN PARALLEL (8 cores): each is an independent offline
 *    world, so they cannot interfere; it just buys ~4x the samples per hour of wall clock.
 * 3. Input policy. Real keyboard/mouse is used for: starting, throttle/steering, charging and
 *    releasing a cast, the strike, the reel (ArrowDown held/released from the tension bar, same
 *    shape as capture-fishing.mjs's bang-bang), keep/release, cooler, weigh-in, J to dive,
 *    swimming/sprinting/descending, firing the speargun (a real mouse click on the canvas),
 *    hauling (S), the leaderboard button, and R to race. Debug hooks are used ONLY where real
 *    input is genuinely impractical, each marked HOOK below with the reason:
 *      - __fishDebug.teleport: the walk from harbor to reef/Gulf Stream is minutes of real
 *        driving; we drive for real in the `drive` session (and report how far it got) and
 *        teleport for the fishing/dive sessions so wall clock buys catches, not commuting.
 *      - __spearDebug.setLook: pointer-drag aiming a MOVING fish from a stale (~3 fps) aim
 *        readback converges to a constant lag (measured and explained at the hook itself), so
 *        aim is set directly. This makes the hit rate an UPPER BOUND on a human's; the `aim
 *        error` ladder below (0 / 0.12 / 0.25 rad) shows how much the assist forgives.
 *      - __spearDebug.forceReloadReady: the 2.5 SIMULATED-second reload would cost ~17 wall s.
 *        The reload is reported analytically (SPEAR_RELOAD) rather than waited out.
 *      - __catchPortraitDebug.land: the `meta` session needs a cooler with fish in it to test
 *        keep -> weigh-in; the economy loop is what is measured there, not the catch.
 * 4. The bot plays competently. A sloppy human loses more fights (see playthrough-model.mjs's
 *    policy ladder); this measures what the DESIGN allows, not a particular player's skill.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARINAS, zoneAt } from '@keysrun/shared/world/depth';
import { chainZ } from '@keysrun/shared/world/chain';
import { SPEAR_RELOAD } from '@keysrun/shared/sim/spear';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || 'http://localhost:5191';
const OUT = path.join(HERE, 'playthrough');
fs.mkdirSync(OUT, { recursive: true });
const ONLY = new Set((process.env.PT_ONLY || 'drive,reef,hawk,offshore,dive,meta').split(','));
const CASTS = +(process.env.PT_CASTS || 4);
const SHOTS = +(process.env.PT_SHOTS || 9);
const QUALITY = process.env.PT_QUALITY || 'Low';
const VIEWPORT = { width: 800, height: 500 }; // small on purpose: software GL cost scales with pixels

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (n) => (Number.isFinite(n) ? +n.toFixed(1) : n);
const r2 = (n) => (Number.isFinite(n) ? +n.toFixed(2) : n);

// Known-good world positions (see dive-integration.mjs / the model): x=60 reef crest line,
// Hawk Channel off the harbor mouth, and the Gulf Stream beyond the reef.
const POS = {
  reef: { x: 60, z: chainZ(60) + 1460, h: Math.PI },
  // z=241 is the open-water Hawk Channel point playthrough-model.mjs found (dz=440 is a flats shoal)
  hawk: { x: -1150, z: 241, h: Math.PI },
  // absolute z inside the Gulf Stream at x=-1150 (playthrough-model.mjs's zoneAt walk found Offshore here)
  offshore: { x: -1150, z: 2066, h: Math.PI },
};

/* --------------------------------- page plumbing ---------------------------------------- */

/** Injected before any game script: a sim-time integrator, a toast recorder, and key/strike
 * stamps, all in SIMULATED seconds (see header note 1). */
const INIT = () => {
  const pt = (window.__pt = { sim: 0, frames: 0, last: 0, wall0: performance.now(), toasts: [], keys: [], strikeSim: null, strikeShown: [] });
  const tick = (ts) => {
    if (pt.last) { pt.sim += Math.min((ts - pt.last) / 1000, 0.05); pt.frames++; }
    pt.last = ts;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.addEventListener('keydown', (e) => { pt.keys.push({ code: e.code, sim: pt.sim }); if (pt.keys.length > 400) pt.keys.shift(); }, true);
  document.addEventListener('DOMContentLoaded', () => {
    const toast = document.getElementById('toast');
    if (toast) new MutationObserver(() => pt.toasts.push({ sim: pt.sim, text: toast.textContent || '' })).observe(toast, { childList: true, characterData: true, subtree: true });
    const strike = document.getElementById('strike');
    if (strike) new MutationObserver(() => { if (!strike.classList.contains('hidden')) pt.strikeShown.push(pt.sim); }).observe(strike, { attributes: true, attributeFilter: ['class'] });
  });
};

class Session {
  constructor(name, browser) { this.name = name; this.browser = browser; this.events = []; this.errors = []; this.t0 = Date.now(); this.m = {}; }
  async open() {
    this.page = await this.browser.newPage({ viewport: VIEWPORT });
    // Parallel software-GL pages starve each other: a click can wait tens of wall seconds for a frame.
    this.page.setDefaultTimeout(300000);
    this.page.on('pageerror', (e) => this.errors.push(String(e)));
    this.page.on('console', (m) => { if (m.type() === 'error') this.errors.push(m.text().slice(0, 200)); });
    await this.page.addInitScript(INIT);
  }
  sim() { return this.page.evaluate(() => window.__pt.sim); }
  wall() { return (Date.now() - this.t0) / 1000; }
  /** Timeline entry. `novel` marks things a player would call "something new happened". */
  async ev(type, data = {}, novel = false) {
    const e = { type, wall: r1(this.wall()), sim: r1(await this.sim()), ...data, novel };
    this.events.push(e);
    console.log(`[${this.name}] sim ${e.sim}s  ${type} ${JSON.stringify(data)}`);
    return e;
  }
  async until(fn, wallMs, every = 150) {
    const t = Date.now();
    while (Date.now() - t < wallMs) { const v = await fn(); if (v) return v; await sleep(every); }
    return null;
  }
  text(id) { return this.page.evaluate((i) => document.getElementById(i)?.textContent ?? '', id); }
  hidden(id) { return this.page.evaluate((i) => document.getElementById(i)?.classList.contains('hidden') ?? true, id); }
  widthPct(id) { return this.page.evaluate((i) => parseFloat(document.getElementById(i)?.style.width || '0'), id); }
  boat() { return this.page.evaluate(() => window.__fishDebug.boatState()); }
  toastsSince(sim) { return this.page.evaluate((s) => window.__pt.toasts.filter((t) => t.sim >= s).map((t) => t.text), sim); }
  /** HOOK: __fishDebug.teleport (see header 3). */
  async teleport(p) { await this.page.evaluate(({ x, z, h }) => window.__fishDebug.teleport(x, z, h), p); await sleep(1200); }
  async shot(label) { try { await this.page.screenshot({ path: path.join(OUT, `${this.name}-${label}.png`) }); } catch { /* best effort */ } }

  /** Start screen -> in the boat. Reports the real onboarding friction a new player sees. */
  async boot(pick) {
    const t = Date.now();
    await this.page.goto(BASE, { waitUntil: 'load' });
    const offline = this.page.locator('.krAuthOffline');
    await this.page.waitForSelector('#btnGo, .krAuthOffline', { timeout: 120000 });
    if (await offline.count()) { await offline.click(); await sleep(500); }
    for (let i = 0; i < 5 && !(await this.text('btnQualityStart')).includes(QUALITY); i++) { await this.page.click('#btnQualityStart'); await sleep(250); }
    const boats = await this.page.evaluate(() => Array.from(document.querySelectorAll('#boats > *')).map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)));
    if (pick !== undefined) { await this.page.locator('#boats > *').nth(pick).click().catch(() => {}); }
    await this.page.click('#btnGo');
    await this.until(async () => !(await this.hidden('gauges')), 120000, 300);
    this.m.bootWallSec = r1((Date.now() - t) / 1000);
    this.m.boatsOnStartScreen = boats.length;
    this.m.startScreenBoats = boats;
    await this.ev('boot', { bootWallSec: this.m.bootWallSec, boatsOffered: boats.length });
    // Honest slowdown ratio for the whole report: simulated seconds per wall second.
    await sleep(6000);
    const { sim, frames, wallMs } = await this.page.evaluate(() => ({ sim: window.__pt.sim, frames: window.__pt.frames, wallMs: performance.now() - window.__pt.wall0 }));
    this.m.simPerWall = r2(sim / (wallMs / 1000));
    this.m.framesPerWallSec_sandboxOnly = r1(frames / (wallMs / 1000));
  }
}

/* --------------------------------- rod fishing ------------------------------------------- */

/** One full rod cycle with real input. Returns the structured record; never throws. */
async function rodCycle(S, zoneLabel, idx, opts = {}) {
  const page = S.page;
  const rec = { zone: zoneLabel, n: idx, outcome: null };
  // FINDING (first full run): the reel key IS the astern throttle key (boatInput.back = ArrowDown,
  // game/fishing/update.ts `reel = boatInput.back || ...`), so every fight leaves the boat
  // backing down and the very next cast is refused with "Slow under 3 knots to cast." A real
  // player has to notice and feather the throttle back; the bot does the same with real keys and
  // we count how often it was needed, because that is friction the player feels.
  rec.settleTaps = 0;
  for (let k = 0; k < 25; k++) {
    const b = await S.boat();
    if (Math.abs(b.speed) < 1.0) break;
    await page.keyboard.down(b.speed < 0 ? 'KeyW' : 'KeyS'); await sleep(350); await page.keyboard.up(b.speed < 0 ? 'KeyW' : 'KeyS');
    rec.settleTaps++; await sleep(500);
  }
  const simCastStart = await S.sim();
  // -- cast: hold Space until the on-screen distance readout reaches the target power.
  const wantM = opts.castM ?? 45;
  await page.keyboard.down('Space');
  const charging = await S.until(async () => !(await S.hidden('castbar')), 8000, 100);
  if (!charging) { await page.keyboard.up('Space'); rec.outcome = 'cast-refused'; rec.toasts = await S.toastsSince(simCastStart); return rec; }
  await S.until(async () => parseFloat(await S.text('castDist')) >= wantM, 30000, 80);
  await page.keyboard.up('Space');
  const simReleased = await S.sim();
  rec.castChargeSimSec = r2(simReleased - simCastStart);
  rec.castDistM = parseFloat(await S.text('castDist'));

  // -- wait for the bite (the strike prompt). Everything between release and here is the
  //    "waiting" + "nibble" phases; the bite is structurally guaranteed unless the cast is aborted.
  await page.evaluate(() => { window.__pt.strikeShown.length = 0; });
  // Timeout in SIMULATED seconds (bite timer is 4-10 s + up to 3 nibbles), not wall: a contended
  // run advances ~0.01 sim s per wall s, and a wall timeout would call a slow machine "no bite".
  const bit = await S.until(async () => {
    if (!(await S.hidden('strike'))) return true;
    const t = await S.toastsSince(simReleased);
    if (t.some((x) => /reeled in|Drifted/.test(x))) return 'aborted';
    return (await S.sim()) - simReleased > 45 ? 'timeout' : false;
  }, 3 * 3600 * 1000, 250);
  if (bit !== true) { rec.outcome = bit === 'aborted' ? 'line-reeled-in' : 'no-bite-timeout'; rec.simWaited = r1((await S.sim()) - simReleased); return rec; }
  const biteSim = await page.evaluate(() => window.__pt.strikeShown[0] ?? window.__pt.sim);
  rec.biteWaitSimSec = r2(biteSim - simReleased);
  await S.ev('bite', { waitSimSec: rec.biteWaitSimSec });

  // -- strike. Reaction budget in the game is 1.4 simulated seconds.
  await page.keyboard.press('Space');
  const keySim = await page.evaluate(() => window.__pt.keys.filter((k) => k.code === 'Space').pop()?.sim ?? 0);
  rec.reactionSimSec = r2(keySim - biteSim);
  // The fight panel can open and close inside one poll when the fish is lost instantly (e.g. a
  // bobber near land -> "Cut off in the mangroves"), so also watch the toasts for a verdict.
  const hooked = await S.until(async () => {
    if (!(await S.hidden('fight'))) return 'on';
    const t = (await S.toastsSince(biteSim)).join(' | ');
    return /Missed it|Cut off|Snap|Slack|Spooled|too early/i.test(t) ? t : false;
  }, 120000, 100);
  if (hooked !== 'on') {
    const why = hooked || '';
    rec.outcome = /Cut off|Snap|Slack|Spooled/.test(why) ? 'lost' : 'missed-strike';
    rec.lossReason = /Snap/.test(why) ? 'snapped' : /Slack/.test(why) ? 'slack' : /Spooled/.test(why) ? 'spooled' : /Cut off/.test(why) ? 'mangrove' : 'strike-window';
    rec.toasts = await S.toastsSince(biteSim);
    await S.ev(rec.outcome === 'lost' ? 'fight-lost' : 'strike-missed', { reason: rec.lossReason });
    return rec;
  }
  rec.fishOnLabel = await S.text('fLabel'); // "Fish on" / "Solid fish on" / "Something heavy is on": size, never species
  const fightStartSim = await S.sim();
  await S.shot(`fight-${zoneLabel}-${idx}`);

  // -- fight: same bang-bang the existing harnesses use, with real ArrowDown held/released.
  let down = false, peakTension = 0, ended = null;
  const FIGHT_WALL = 2 * 3600 * 1000; // the real limit is simulated: 120 s below
  const tFight = Date.now();
  while (Date.now() - tFight < FIGHT_WALL && (await S.sim()) - fightStartSim < 120) {
    const s = await page.evaluate(() => ({
      fightHidden: document.getElementById('fight')?.classList.contains('hidden') ?? true,
      cardHidden: document.getElementById('card')?.classList.contains('hidden') ?? true,
      tension: parseFloat(document.getElementById('fT')?.style.width || '0'),
    }));
    if (!s.cardHidden) { ended = 'landed'; break; }
    if (s.fightHidden) { ended = 'lost'; break; }
    peakTension = Math.max(peakTension, s.tension);
    const want = s.tension < 78;
    if (want && !down) { await page.keyboard.down('ArrowDown'); down = true; }
    else if (!want && down) { await page.keyboard.up('ArrowDown'); down = false; }
    await sleep(60);
  }
  if (down) await page.keyboard.up('ArrowDown');
  rec.fightSimSec = r2((await S.sim()) - fightStartSim);
  rec.peakTensionPct = r1(peakTension);
  if (ended === 'lost' || !ended) {
    const msgs = await S.toastsSince(fightStartSim);
    const why = msgs.join(' | ');
    rec.outcome = ended === 'lost' ? 'lost' : 'fight-timeout';
    rec.lossReason = /Snap/.test(why) ? 'snapped' : /Slack/.test(why) ? 'slack' : /Spooled/.test(why) ? 'spooled' : /mangrove/i.test(why) ? 'mangrove' : 'unknown: ' + why.slice(0, 80);
    await S.ev('fight-lost', { reason: rec.lossReason, fightSimSec: rec.fightSimSec, sizeHint: rec.fishOnLabel });
    return rec;
  }

  // -- landed: read the card, then keep or release for real.
  rec.outcome = 'landed';
  rec.species = (await S.text('cName')).trim();
  rec.weightLb = parseFloat(await S.text('cWeight'));
  rec.points = parseInt((await S.text('cPts')).replace(/[^0-9]/g, ''), 10);
  rec.bonus = (await S.text('cBonus')).trim();
  rec.meatLine = (await S.text('cPrice')).trim();
  rec.cardNote = (await S.text('cNote')).trim();
  rec.cycleSimSec = r2((await S.sim()) - simCastStart);
  await S.ev('catch', { species: rec.species, lb: rec.weightLb, pts: rec.points, fightSimSec: rec.fightSimSec, cycleSimSec: rec.cycleSimSec });
  if (idx === 0) await S.shot(`catch-${zoneLabel}`);
  await sleep(2200); // the card ignores K/Release for 600 ms WALL; also a human reads it
  const keepDisabled = await page.evaluate(() => document.getElementById('btnKeep')?.disabled ?? true);
  rec.keepable = !keepDisabled;
  if (!keepDisabled && opts.keep) await page.keyboard.press('KeyK'); else await page.click('#btnRelease');
  await S.until(async () => await S.hidden('card'), 120000, 200);
  await sleep(1500);
  return rec;
}

async function fishingSession(browser, key, label) {
  const S = new Session(key, browser); await S.open();
  await S.boot();
  const catches = [];
  await S.teleport(POS[key]);
  await S.ev('arrive', { zone: zoneAt(POS[key].x, POS[key].z) });
  const t0 = await S.sim();
  let reloads = 0;
  for (let i = 0; i < CASTS; i++) {
    let rec;
    try { rec = await rodCycle(S, label, i, { keep: i < 2 }); } catch (e) {
      // game/main.ts reloads the page on WebGL context loss, which software GL under load
      // provokes; the sim clock restarts, so reboot and count it rather than abort the session.
      rec = { zone: label, n: i, outcome: 'page-reloaded', error: String(e).slice(0, 120) };
      reloads++;
      await S.boot(); await S.teleport(POS[key]);
    }
    catches.push(rec);
    // A contended machine can make one cycle take many minutes; keep what we have on disk as we go.
    fs.writeFileSync(path.join(OUT, `partial-${key}.json`), JSON.stringify({ records: catches, events: S.events }, null, 1));
    if (rec.outcome === 'cast-refused' || rec.outcome === 'no-bite-timeout' || rec.outcome === 'line-reeled-in') {
      // reset the boat in place (drift/aborts) and try again; counted, not hidden
      await S.teleport(POS[key]);
    }
  }
  S.m.rod = { casts: catches.length, pageReloads: reloads, records: catches, firstCatchSimSec: r1((catches.map((c, i) => ({ c, i })).find((x) => x.c.outcome === 'landed') ? ((await S.sim()) - t0) : NaN)) };
  return S;
}

/* --------------------------------- driving ---------------------------------------------- */

async function driveSession(browser) {
  const S = new Session('drive', browser); await S.open();
  await S.boot();
  const b0 = await S.boat();
  const samples = [];
  // Real throttle: hold W and sample the boat's true state against simulated time.
  await S.page.keyboard.down('KeyW');
  const wallLimit = 150000, t = Date.now();
  let topSeen = 0, tTo90 = null;
  const sim0 = await S.sim();
  while (Date.now() - t < wallLimit) {
    const b = await S.boat(); const sim = await S.sim();
    samples.push({ sim: r1(sim - sim0), speed: r2(b.speed), x: Math.round(b.x), z: Math.round(b.z), h: r2(b.h) });
    topSeen = Math.max(topSeen, b.speed);
    if (tTo90 === null && topSeen > 0 && b.speed >= 0.9 * topSeen && sim - sim0 > 3 && samples.length > 6) tTo90 = r1(sim - sim0);
    await sleep(1500);
    if (sim - sim0 > 70) break;
  }
  await S.page.keyboard.up('KeyW');
  const b1 = await S.boat();
  // Steering: tap-hold A for a few sim seconds and read the heading change (calibrates turn rate).
  const hA = (await S.boat()).h; const simA = await S.sim();
  await S.page.keyboard.down('KeyA'); await sleep(5000); await S.page.keyboard.up('KeyA');
  const bA = await S.boat(); const simA2 = await S.sim();
  S.m.drive = {
    boat: 'default start-screen boat (first card)', start: { x: Math.round(b0.x), z: Math.round(b0.z) }, end: { x: Math.round(b1.x), z: Math.round(b1.z) },
    metresCovered: Math.round(Math.hypot(b1.x - b0.x, b1.z - b0.z)),
    simSecHoldingThrottle: r1(samples.length ? samples[samples.length - 1].sim : 0),
    topSpeedSeen_ms: r2(topSeen), simSecTo90pctOfSeenTop: tTo90,
    zoneAtEnd: zoneAt(b1.x, b1.z), turnRate_radPerSimSec: r2(Math.abs(bA.h - hA) / Math.max(0.1, simA2 - simA)),
    samples: samples.filter((_, i) => i % 3 === 0),
  };
  await S.ev('drive-summary', { metres: S.m.drive.metresCovered, topMs: S.m.drive.topSpeedSeen_ms, zoneAtEnd: S.m.drive.zoneAtEnd });
  await S.shot('end');
  return S;
}

/* --------------------------------- diving + spearfishing --------------------------------- */

async function diveSession(browser) {
  const S = new Session('dive', browser); await S.open();
  await S.boot();
  await S.teleport(POS.reef);
  const page = S.page;
  const airPct = async () => parseInt((await S.text('airPct')).replace(/[^0-9]/g, ''), 10);
  const depth = async () => parseFloat((await S.text('diveDepth')) || '0');

  // -- J to go overboard (real key), descend with C (real), park at ~3 m on the crest.
  await page.keyboard.press('KeyJ');
  await S.until(async () => !(await S.hidden('diverHud')), 20000, 200);
  const simIn = await S.sim();
  await S.ev('overboard', {}, true);
  await page.keyboard.down('KeyC');
  await S.until(async () => (await depth()) >= 2.8, 90000, 150);
  await page.keyboard.up('KeyC');
  let diveStartSim = await S.sim();
  const a0 = await airPct();
  await S.shot('underwater');

  // The diver is positively buoyant above NEUTRAL_DEPTH (11 m, shared/sim/diver.ts), so
  // "hovering" at 3 m means kicking down on and off like a real freediver; the first full run
  // let go of C and simply floated back to the surface, which hid the air burn entirely.
  const HOVER = 3.2;
  const keep = async () => { const dd = await depth(); if (dd < HOVER - 0.4) await page.keyboard.down('KeyC'); else await page.keyboard.up('KeyC'); };
  const hoverFor = async (ms) => { const t = Date.now(); while (Date.now() - t < ms) { await keep(); await sleep(250); } };

  // -- Fish census while we hover: what can the gun actually see, and how often is it nothing?
  const census = [];
  const dive = { airSeries: [], mustSurfaceAtSimSec: null, depthAtWarn: null, durations: [] };
  const shots = [];
  const ladder = [0, 0.12, 0.25];
  let shotNo = 0;
  const tEnd = Date.now() + 25 * 60 * 1000;
  let diveCount = 1;
  let warnedThisDive = false;
  while (shotNo < SHOTS && Date.now() < tEnd) {
    await keep();
    const sim = await S.sim();
    const air = await airPct();
    dive.airSeries.push({ sim: r1(sim - diveStartSim), air, depth: await depth() });
    const warn = (await S.text('ascentWarn')).trim();
    if (warn && !warnedThisDive) { warnedThisDive = true; dive.mustSurfaceAtSimSec ??= r1(sim - diveStartSim); dive.depthAtWarn ??= await depth(); dive.warnText ??= warn; }
    // 30% is the HUD's own "Air low" line (entities/diver/hud.ts); record when the player first gets it.
    if (air <= 30) { dive.airLowAtSimSec ??= r1(sim - diveStartSim); dive.airLowDepthM ??= await depth(); }
    if (air <= 22) {
      dive.durations.push(r1(sim - diveStartSim));
      // Surface for a breath with real keys (Shift+Space), like a player told "Air low".
      await S.ev('surface-for-air', { air, diveSimSec: r1(sim - diveStartSim) });
      await page.keyboard.down('ShiftLeft'); await page.keyboard.down('Space');
      await S.until(async () => (await depth()) <= 0.4, 60000, 150);
      await page.keyboard.up('Space'); await page.keyboard.up('ShiftLeft');
      await S.until(async () => (await airPct()) >= 95, 40000, 200);
      const refillSim = await S.sim(); dive.refillSimSec ??= r1(refillSim - sim);
      await page.keyboard.down('KeyC');
      await S.until(async () => (await depth()) >= 2.8, 60000, 150);
      await page.keyboard.up('KeyC');
      diveStartSim = await S.sim(); diveCount++; warnedThisDive = false;
      continue;
    }
    const tg = await page.evaluate(() => window.__spearDebug.targets());
    census.push({ sim: r1(sim), n: tg.length, nearestM: tg.length ? Math.min(...tg.map((t) => t.dist)) : null, species: [...new Set(tg.map((t) => t.key))] });
    const cand = tg.filter((t) => t.dist <= 9.5).sort((a, b) => a.dist - b.dist)[0];
    if (!cand) { await hoverFor(2500); continue; }
    // Aim at it. HOOK: __spearDebug.setLook (header 3) — with an angular error from the ladder.
    // Then CLOSE THE LOOP: read back the gun's own aimDir (a frame stale at this fps) and refire
    // setLook at the fish's current position until the measured angle to the fish matches the
    // intended error. Without this the first full run measured the harness's aim lag, not the gun
    // (2/9 hits at "perfect" aim with the fish a metre away).
    const eps = ladder[shotNo % ladder.length];
    let aimGap = null, tgt = cand;
    for (let tries = 0; tries < 14; tries++) {
      await keep();
      const now = (await page.evaluate(() => window.__spearDebug.targets())).find((t) => t.id === cand.id) ?? tgt;
      tgt = now;
      await page.evaluate(({ t, eps }) => {
        const cam = window.__spearDebug.camPos();
        const vx = t.x - cam.x, vy = t.y - cam.y, vz = t.z - cam.z, L = Math.hypot(vx, vy, vz) || 1;
        const px = -vz / (Math.hypot(vx, vz) || 1), pz = vx / (Math.hypot(vx, vz) || 1);
        window.__spearDebug.setLook(t.x + px * L * Math.tan(eps), t.y, t.z + pz * L * Math.tan(eps));
      }, { t: now, eps });
      await sleep(600);
      aimGap = await page.evaluate(({ id }) => {
        const d = window.__spearDebug, cam = d.camPos(), a = d.aimDir();
        const t = d.targets().find((x) => x.id === id);
        if (!t) return null;
        const vx = t.x - cam.x, vy = t.y - cam.y, vz = t.z - cam.z, L = Math.hypot(vx, vy, vz) || 1;
        return Math.acos(Math.max(-1, Math.min(1, (a.x * vx + a.y * vy + a.z * vz) / L)));
      }, { id: cand.id });
      if (aimGap !== null && Math.abs(aimGap - eps) < 0.05) break;
    }
    // HOOK: forceReloadReady (header 3). The 2.5 s reload is reported analytically.
    await page.evaluate(() => window.__spearDebug.forceReloadReady());
    const fireSim = await S.sim();
    const assistBefore = await page.evaluate(() => window.__spearDebug.aimTargetId());
    // Fire = REAL left click on the canvas (entities/speargun/input.ts binds pointerdown).
    await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2);
    // isActive() is true while the shaft is merely IN FLIGHT (`!!shot || !!speared`), so a hit is
    // fightState() becoming non-null; a miss is the gun going inactive without it ever doing so.
    const verdict = await S.until(async () => page.evaluate(() => (window.__spearDebug.fightState() ? 'hit' : window.__spearDebug.isActive() ? false : 'miss')), 30000, 100);
    const hit = verdict === 'hit';
    const rec = { n: shotNo, aimErrorRad: eps, species: cand.key, targetDistM: cand.dist, hit: !!hit, aimGapAtFireRad: aimGap === null ? null : r2(aimGap), assistLockedBeforeShot: assistBefore !== null };
    shotNo++;
    if (hit) {
      const fsim = await S.sim();
      let down = false, peak = 0;
      const tf = Date.now();
      while (Date.now() - tf < 240000) {
        const st = await page.evaluate(() => ({ active: window.__spearDebug.isActive(), f: window.__spearDebug.fightState() }));
        if (!st.f || st.f.outcome !== 'fighting') break;
        peak = Math.max(peak, st.f.tension);
        const want = st.f.tension < 0.8;
        if (want && !down) { await page.keyboard.down('KeyS'); down = true; } else if (!want && down) { await page.keyboard.up('KeyS'); down = false; }
        await sleep(60);
      }
      if (down) await page.keyboard.up('KeyS');
      const cardUp = !!(await S.until(async () => !(await S.hidden('card')), 6000, 150));
      rec.fightSimSec = r2((await S.sim()) - fsim);
      rec.peakTension = r2(peak);
      if (cardUp) {
        rec.outcome = 'landed';
        rec.landedSpecies = (await S.text('cName')).trim(); rec.weightLb = parseFloat(await S.text('cWeight')); rec.points = parseInt((await S.text('cPts')).replace(/[^0-9]/g, ''), 10);
        await S.ev('spear-catch', { species: rec.landedSpecies, lb: rec.weightLb, pts: rec.points }, true);
        await sleep(2200); await page.click('#btnRelease').catch(() => {}); await S.until(async () => await S.hidden('card'), 20000, 200);
      } else { rec.outcome = 'torn-free'; rec.toasts = await S.toastsSince(fsim); }
    } else {
      rec.outcome = 'miss';
      await page.evaluate(() => window.__spearDebug.reset()); // drop the dead shaft so the next shot is clean
    }
    shots.push(rec);
    await S.ev('spear-shot', { n: rec.n, err: eps, hit: rec.hit, outcome: rec.outcome, sp: rec.species });
  }
  const hitsByErr = {};
  for (const e of ladder) { const s = shots.filter((x) => x.aimErrorRad === e); hitsByErr[e] = { shots: s.length, hits: s.filter((x) => x.hit).length }; }
  S.m.dive = {
    diveCount, startAirPct: a0, airLowAtSimSec: dive.airLowAtSimSec ?? null, airLowDepthM: dive.airLowDepthM ?? null, diveDurationsSimSec: dive.durations, surfaceAndRefillSimSec: dive.refillSimSec ?? null, mustSurfaceAtSimSec: dive.mustSurfaceAtSimSec, depthAtWarnM: dive.depthAtWarn, warnText: dive.warnText ?? null,
    airSeries: dive.airSeries.filter((_, i) => i % 2 === 0),
  };
  const withTargets = census.filter((c) => c.n > 0).length;
  S.m.spear = {
    shots: shots.length, hits: shots.filter((s) => s.hit).length, landed: shots.filter((s) => s.outcome === 'landed').length,
    hitRatePct: r1(100 * shots.filter((s) => s.hit).length / Math.max(1, shots.length)), hitsByAimError: hitsByErr,
    reloadSimSec_analytic: SPEAR_RELOAD, censusSamples: census.length, censusSamplesWithAnyTargetInRange: withTargets,
    meanTargetsInRange: r2(census.reduce((a, c) => a + c.n, 0) / Math.max(1, census.length)),
    speciesSeenAsTargets: [...new Set(census.flatMap((c) => c.species))], shotRecords: shots,
  };
  await S.shot('end');
  return S;
}

/* --------------------------------- economy / leaderboard / race --------------------------- */

async function metaSession(browser) {
  const S = new Session('meta', browser); await S.open();
  await S.boot();
  const page = S.page;
  const score = async () => parseInt((await S.text('scScore')).replace(/[^0-9]/g, '') || '0', 10);
  const meta = { score0: await score() };

  // Cooler economy. HOOK: __catchPortraitDebug.land (header 3) — we are measuring keep -> weigh-in.
  const fishes = [['yellowtail', 4], ['mahi', 30], ['grouper', 55], ['bonefish', 8]];
  meta.cooler = [];
  for (const [k, w] of fishes) {
    const before = await score();
    await page.evaluate(([k, w]) => window.__catchPortraitDebug.land(k, w), [k, w]);
    await sleep(1500);
    meta.cooler.push({ key: k, lb: w, pts: parseInt((await S.text('cPts')).replace(/[^0-9]/g, ''), 10), price: (await S.text('cPrice')).trim(), note: (await S.text('cNote')).trim(), keepDisabled: await page.evaluate(() => document.getElementById('btnKeep')?.disabled) });
    await sleep(800);
    if (!meta.cooler.at(-1).keepDisabled) await page.keyboard.press('KeyK'); else await page.click('#btnRelease');
    await S.until(async () => await S.hidden('card'), 20000, 200);
    meta.cooler.at(-1).scoreDelta = (await score()) - before;
  }
  meta.coolerLabel = (await S.text('coolerTxt')).trim();
  await page.keyboard.press('KeyQ'); await sleep(600); await S.shot('cooler'); await page.keyboard.press('KeyQ'); await sleep(300);

  // Weigh-in at the nearest marina: teleport to its dock (HOOK, commuting), then press E for real.
  const M = MARINAS[0];
  await S.teleport({ x: M.sx, z: M.sz, h: 0 });
  const sBefore = await score();
  await page.keyboard.press('KeyE'); await sleep(1500);
  meta.weighIn = { marina: M.name, scoreDelta: (await score()) - sBefore, toast: (await S.toastsSince(0)).slice(-1)[0] };
  await S.ev('weigh-in', meta.weighIn, true);

  // The boat choice is a start-screen-only decision; is there any in-world way to change it?
  meta.inWorldBoatChange = await page.evaluate(() => ({ btnIds: Array.from(document.querySelectorAll('button')).map((b) => b.id).filter(Boolean) }));
  // Leaderboard: the public board, opened with the real button.
  await page.click('text=Leaderboard').catch(() => {});
  await sleep(3500);
  meta.leaderboard = await page.evaluate(() => {
    const panel = document.querySelector('.krLbPanel');
    if (!panel) return null;
    return { open: !panel.classList.contains('hidden'), rows: Array.from(panel.querySelectorAll('li')).slice(0, 12).map((li) => ({ empty: li.classList.contains('empty'), text: (li.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 110) })), sub: (panel.querySelector('.krLbSub')?.textContent || '').trim() };
  });
  await S.shot('leaderboard');
  await page.keyboard.press('Escape'); await sleep(400);
  await page.evaluate(() => document.querySelector('.krLbPanel')?.classList.add('hidden'));

  // Race: R starts the 2-lap buoy race. Report what the player is offered.
  await page.keyboard.press('KeyR'); await sleep(4000);
  meta.race = await page.evaluate(() => ({ hud: (document.querySelector('.raceHud')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200) }));
  await S.shot('race');
  S.m.meta = meta;
  return S;
}

/* --------------------------------- aggregate + report ------------------------------------ */

function aggregate(sessions) {
  const all = sessions.flatMap((s) => s.events.map((e) => ({ ...e, session: s.name })));
  const rod = sessions.flatMap((s) => s.m.rod?.records ?? []);
  const landed = rod.filter((r) => r.outcome === 'landed');
  const lost = rod.filter((r) => r.outcome === 'lost');
  const fights = landed.length + lost.length;
  const cycleSim = landed.map((r) => r.cycleSimSec);
  const mean = (a) => (a.length ? r2(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const bites = rod.filter((r) => r.biteWaitSimSec !== undefined);
  const lossReasons = {};
  for (const l of lost) lossReasons[l.lossReason] = (lossReasons[l.lossReason] ?? 0) + 1;
  const speciesRod = {};
  for (const l of landed) speciesRod[l.species] = (speciesRod[l.species] ?? 0) + 1;
  const spear = sessions.find((s) => s.m.spear)?.m.spear;
  // Novelty timeline PER SESSION (each is its own simulated clock): the longest stretch of
  // simulated time in which no species/record/bonus/mode appeared.
  const novelty = sessions.map((s) => {
    const seen = new Set(); let best = 0; const marks = [0]; const rows = [];
    for (const e of s.events) {
      let isNew = e.novel;
      if ((e.type === 'catch' || e.type === 'spear-catch') && !seen.has(e.species)) { seen.add(e.species); isNew = true; }
      if (isNew) { marks.push(e.sim); rows.push([e.sim, e.type + (e.species ? ':' + e.species : '')]); }
    }
    const endSim = s.events.length ? s.events[s.events.length - 1].sim : 0;
    marks.push(endSim);
    for (let i = 1; i < marks.length; i++) best = Math.max(best, marks[i] - marks[i - 1]);
    return { session: s.name, totalSimSec: endSim, newThingCount: rows.length, longestStretchWithNothingNewSimSec: r1(best), newThings: rows };
  });
  return {
    attempts: { casts: rod.length, bites: bites.length, strikes_missed: rod.filter((r) => r.outcome === 'missed-strike').length, fightsStarted: fights, landed: landed.length, lost: lost.length },
    biteRate_pctOfCastsThatBit: r1(100 * bites.length / Math.max(1, rod.length)),
    meanBiteWaitSimSec: mean(bites.map((r) => r.biteWaitSimSec)),
    meanReactionSimSec_budget1p4: mean(bites.map((r) => r.reactionSimSec).filter((x) => x !== undefined)),
    fightWinPct: r1(100 * landed.length / Math.max(1, fights)), lossReasons,
    meanFightSimSec: mean(landed.map((r) => r.fightSimSec)), meanCycleSimSec: mean(cycleSim),
    catchesPerSimMinuteOfFishing: cycleSim.length ? r2(60 / mean(cycleSim)) : null,
    speciesLanded: speciesRod, distinctSpeciesLanded: Object.keys(speciesRod).length,
    pointsPerCatch: mean(landed.map((r) => r.points)), pointsRange: [Math.min(...landed.map((r) => r.points)), Math.max(...landed.map((r) => r.points))],
    byZone: Object.fromEntries(['Hawk Channel', 'Reef', 'Gulf Stream'].map((z) => [z, { landed: landed.filter((r) => r.zone === z).map((r) => `${r.species} ${r.weightLb}lb`), lost: lost.filter((r) => r.zone === z).length, meanBiteWait: mean(rod.filter((r) => r.zone === z && r.biteWaitSimSec !== undefined).map((r) => r.biteWaitSimSec)) }])),
    dive: sessions.find((s) => s.m.dive)?.m.dive ?? null, spear: spear ? { ...spear, shotRecords: undefined } : null,
    novelty, simPerWall: Object.fromEntries(sessions.map((s) => [s.name, s.m.simPerWall])),
    timeline: all.sort((a, b) => a.wall - b.wall),
  };
}

function summarize(agg, sessions, wallMin) {
  const L = [];
  const p = (s = '') => L.push(s);
  p(`KEYS RUN PLAYTHROUGH  (${new Date().toISOString()})  total wall ${wallMin} min; every duration below is SIMULATED seconds`);
  p(`sim-seconds per wall-second by session: ${JSON.stringify(agg.simPerWall)}`);
  p('');
  p('-- Rod fishing (real keyboard, bang-bang reel) --');
  p(`casts ${agg.attempts.casts} -> bites ${agg.attempts.bites} (${agg.biteRate_pctOfCastsThatBit}%), mean bite wait ${agg.meanBiteWaitSimSec}s, mean reaction ${agg.meanReactionSimSec_budget1p4}s of 1.4s budget`);
  p(`fights ${agg.attempts.fightsStarted}: landed ${agg.attempts.landed}, lost ${agg.attempts.lost} (win ${agg.fightWinPct}%)  reasons ${JSON.stringify(agg.lossReasons)}  missed strikes ${agg.attempts.strikes_missed}`);
  p(`mean fight ${agg.meanFightSimSec}s, mean full cast->card cycle ${agg.meanCycleSimSec}s => ${agg.catchesPerSimMinuteOfFishing} catches per simulated minute of fishing`);
  p(`species landed (${agg.distinctSpeciesLanded}): ${JSON.stringify(agg.speciesLanded)}; points/catch mean ${agg.pointsPerCatch} range ${agg.pointsRange}`);
  for (const [z, v] of Object.entries(agg.byZone)) p(`  ${z}: landed [${v.landed.join(', ')}] lost ${v.lost}  mean bite wait ${v.meanBiteWait}s`);
  const d = sessions.find((s) => s.m.drive)?.m.drive;
  if (d) p(`\n-- Driving (real W/A) --\n${d.metresCovered} m in ${d.simSecHoldingThrottle} simulated s, top ${d.topSpeedSeen_ms} m/s, 90% of top after ${d.simSecTo90pctOfSeenTop}s, ended in ${d.zoneAtEnd}; turn rate ${d.turnRate_radPerSimSec} rad/s`);
  if (agg.dive) p(`\n-- Diving (real J/C/Shift/Space) --\n"Air low" (30%) after ${agg.dive.airLowAtSimSec}s at ${agg.dive.airLowDepthM} m; surface-warning text after ${agg.dive.mustSurfaceAtSimSec}s ("${agg.dive.warnText}"); full dive durations ${JSON.stringify(agg.dive.diveDurationsSimSec)}s; surface+refill ${agg.dive.surfaceAndRefillSimSec}s; dives made ${agg.dive.diveCount}`);
  if (agg.spear) p(`-- Spear --\nshots ${agg.spear.shots}, hits ${agg.spear.hits} (${agg.spear.hitRatePct}%), landed ${agg.spear.landed}; by aim error ${JSON.stringify(agg.spear.hitsByAimError)}; mean targets in range ${agg.spear.meanTargetsInRange}; census ${agg.spear.censusSamplesWithAnyTargetInRange}/${agg.spear.censusSamples} samples had a target; reload ${agg.spear.reloadSimSec_analytic}s`);
  const meta = sessions.find((s) => s.m.meta)?.m.meta;
  if (meta) {
    p('\n-- Economy / meta --');
    p(`cooler: ${JSON.stringify(meta.cooler.map((c) => `${c.key} ${c.lb}lb -> ${c.pts}pts keepDisabled=${c.keepDisabled}`))}`);
    p(`weigh-in: ${JSON.stringify(meta.weighIn)}`);
    p(`leaderboard open=${meta.leaderboard?.open} rows=${meta.leaderboard?.rows?.length} first=${meta.leaderboard?.rows?.[0]?.text}`);
    p(`race hud: ${meta.race?.hud}`);
    p(`start-screen boats: ${sessions.find((s) => s.m.startScreenBoats)?.m.boatsOnStartScreen}`);
  }
  p('\n-- Time between anything new (per session, simulated) --');
  for (const n of agg.novelty) p(`${n.session}: ${n.newThingCount} new things in ${n.totalSimSec}s; longest stretch with nothing new ${n.longestStretchWithNothingNewSimSec}s`);
  const errs = sessions.flatMap((s) => s.errors.map((e) => `[${s.name}] ${e}`));
  p(`\npage errors: ${errs.length}${errs.length ? '\n' + errs.slice(0, 8).join('\n') : ''}`);
  return L.join('\n');
}

const t0 = Date.now();
const browser = await chromium.launch();
const jobs = [];
// Staggered starts: six pages all compiling shaders at once starve each other past any sane timeout.
// PT_SERIAL=1 runs one page at a time: on a loaded machine several software-GL pages lose their
// WebGL context (-> game reload) and a serial run is both safer and, per catch, not slower.
const SERIAL = !!process.env.PT_SERIAL;
let chain = Promise.resolve();
const later = (ms, fn) => { if (!SERIAL) return sleep(ms).then(fn); const p = chain.then(fn); chain = p.catch(() => {}); return p; };
if (ONLY.has('drive')) jobs.push(later(0, () => driveSession(browser)));
if (ONLY.has('hawk')) jobs.push(later(25000, () => fishingSession(browser, 'hawk', 'Hawk Channel')));
if (ONLY.has('reef')) jobs.push(later(50000, () => fishingSession(browser, 'reef', 'Reef')));
if (ONLY.has('offshore')) jobs.push(later(75000, () => fishingSession(browser, 'offshore', 'Gulf Stream')));
if (ONLY.has('dive')) jobs.push(later(100000, () => diveSession(browser)));
if (ONLY.has('meta')) jobs.push(later(125000, () => metaSession(browser)));
const settled = await Promise.allSettled(jobs);
const sessions = [];
for (const r of settled) { if (r.status === 'fulfilled') sessions.push(r.value); else console.error('SESSION FAILED', r.reason); }
await browser.close();

const wallMin = r1((Date.now() - t0) / 60000);
const agg = aggregate(sessions);
fs.writeFileSync(path.join(OUT, `report${process.env.PT_TAG || ''}.json`), JSON.stringify({ wallMinutes: wallMin, aggregate: agg, sessions: sessions.map((s) => ({ name: s.name, metrics: s.m, events: s.events, errors: s.errors })), failed: settled.filter((r) => r.status === 'rejected').map((r) => String(r.reason)) }, null, 2));
const summary = summarize(agg, sessions, wallMin);
fs.writeFileSync(path.join(OUT, `summary${process.env.PT_TAG || ''}.txt`), summary);
console.log('\n' + summary);
