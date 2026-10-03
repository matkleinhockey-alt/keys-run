/**
 * Dive integration verification (this task's acceptance criterion). Drives the real diver rig
 * (entities/diver/**) — not a debug camera hook — through every required beat, saving screenshots
 * to test/screenshots/dive/.
 *
 * Approach: teleport, not a real-time swim, for everything except one honest handoff proof.
 *
 * This sandbox renders software WebGL at a couple of fps. game/world.ts's fixed-step accumulator
 * clamps simulated time to <=50 ms per rendered frame (`const clamped = Math.min(0.05, dt);`), so
 * at a few fps real-time play runs 10-40x slower than real time — measured directly in an earlier
 * pass of this script (sprint+descend covered ~2 m in the first 20 real seconds; a full 23 m
 * descent + ascent took the better part of 10 real minutes). The dive *physics* is already proven
 * by packages/shared/test/diver.test.ts's 20 unit tests (exact ATA air burn at 0/10/20/30 m, the
 * buoyancy sign flip at ~11 m, blackout, bit-identical 150-step determinism) — re-proving descent
 * through a browser on top of that adds nothing. What this script actually needs to verify is the
 * *renderer* at a given depth, so `window.__diverDebug` (game/world.ts, same dev/QA-hook
 * convention as the existing `__fishDebug`/`__uwDebug`) jumps straight there.
 *
 * The one real-time exception: leg 1 jumps in for real and sprint-descends to ~5 m under actual
 * physics, proving the boat->diver handoff and the entry surface-crossing genuinely work, before
 * teleporting the rest of the way for bands 2-5. The upward surface crossing is also driven for a
 * few real seconds from just above the water (not teleported across) because that transition
 * (fog/FOV/lens-wetting) is itself time-based — teleporting across it would only prove the hook
 * exists, not that the tween plays.
 *
 * Dive site: x=250 is the Sombrero reef anchor's own x (world/reef/constants.ts's
 * SOMBRERO_ANCHOR_X). dz=1550 (depthAt's "reef wall" branch) gives ~23 m of water there — solved
 * directly against packages/shared/src/world/depth.ts, not guessed — enough to place the diver at
 * every band without hitting bottom. dz=1420, close to the anchor itself (dz=1380), is shallow
 * (~4.5 m) with coral close to the surface, for the coral/fish/Snell's-window beats.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5174';
const OUT = path.join(HERE, 'screenshots', 'dive');
fs.mkdirSync(OUT, { recursive: true });

const chainZ = (x) => 0.000012 * x * x;
const ANCHOR_X = 250;
const DEEP_DZ = 1550; // ~23 m of water — see header
const SHALLOW_DZ = 1420; // ~4.5 m, dense coral near the anchor

async function setTier(page, tierLabel) {
  let label = await page.textContent('#btnQuality');
  for (let i = 0; i < 4 && !label.includes(tierLabel); i++) {
    await page.keyboard.press('KeyG');
    await page.waitForTimeout(300);
    label = await page.textContent('#btnQuality');
  }
}

async function depthM(page) {
  const txt = await page.textContent('#diveDepth');
  return txt ? parseFloat(txt) : NaN;
}

async function waitForDepth(page, cmp, maxMs, pollMs = 1000) {
  const t0 = Date.now();
  let d = await depthM(page);
  while (!cmp(d) && Date.now() - t0 < maxMs) {
    await page.waitForTimeout(pollMs);
    d = await depthM(page);
  }
  return d;
}

async function profilerText(page) {
  return page.evaluate(() => {
    const el = document.getElementById('profilerHud');
    return el ? el.textContent : null;
  });
}

async function dragLook(page, canvas, dx, dy) {
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 12 });
  await page.mouse.up();
}

const errs = [];
const report = { leg1: {}, leg2: {}, errorsAtEachCapture: {} };
function snapshotErrState(label) { report.errorsAtEachCapture[label] = errs.length; }

const browser = await chromium.launch();

// ===================== Leg 1: real handoff + entry, then teleport through bands =====================
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  const DEEP_Z = chainZ(ANCHOR_X) + DEEP_DZ;
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await setTier(page, 'High'); // god rays are High+ only; also the budget this task asks to measure
  await page.click('#btnGo');
  await page.waitForTimeout(800);

  await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: ANCHOR_X, z: DEEP_Z });
  await page.waitForTimeout(800);

  await page.keyboard.press('KeyP'); // profiler HUD on for the whole dive
  await page.waitForTimeout(300);

  await page.screenshot({ path: path.join(OUT, '00-topside-at-reef-wall.png') });
  snapshotErrState('00-topside-at-reef-wall');

  // --- Real handoff: jump in for real, sprint-descend to ~5 m under actual physics. ---
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(600);
  report.leg1.diverHudVisibleAfterJump = await page.evaluate(() => !document.getElementById('diverHud').classList.contains('hidden'));

  await page.screenshot({ path: path.join(OUT, '01-surface-crossing-down.png') });
  snapshotErrState('01-surface-crossing-down');
  report.leg1.depthAtEntry = await depthM(page);

  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('KeyC');
  const realDepth = await waitForDepth(page, (d) => d >= 5, 120_000);
  await page.keyboard.up('KeyC');
  await page.keyboard.up('ShiftLeft');
  report.leg1.realDescentDepth = realDepth;
  await page.screenshot({ path: path.join(OUT, '02-band1-real-descent.png') });
  snapshotErrState('02-band1-real-descent');

  // --- Teleport through the remaining bands (window.__diverDebug — see header). ---
  const BAND_TARGETS = [
    ['03-band2-8m', 8],
    ['04-band3-15m', 15],
    ['05-band4-20m', 20],
    ['06-band5-25m', 25],
  ];
  for (const [label, depth] of BAND_TARGETS) {
    await page.evaluate((d) => window.__diverDebug.setDepth(d), depth);
    await page.waitForTimeout(400); // a couple of rendered frames to settle fog/caustics uniforms
    await page.screenshot({ path: path.join(OUT, `${label}.png`) });
    snapshotErrState(label);
    report.leg1[label] = await depthM(page);
  }

  // Profiler reading while genuinely underwater at depth, for the "< 300 draw calls / < 2.5M
  // triangles underwater" budget.
  report.leg1.profilerUnderwaterAt25m = await profilerText(page);

  // --- Caustics close-up: shallower (full strength 0-10 m per depth-bands.ts), looking down at
  // the seafloor/reef where the projected pattern actually lands. ---
  await page.evaluate(() => window.__diverDebug.setDepth(6));
  await page.evaluate(() => window.__diverDebug.setLook(0, -0.9));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '07-caustics-check.png') });
  snapshotErrState('07-caustics-check');

  // --- Snell's window: shallow, looking straight up. ---
  await page.evaluate(() => window.__diverDebug.setDepth(8));
  await page.evaluate(() => window.__diverDebug.setLook(0, 1.0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, '08-snells-window.png') });
  snapshotErrState('08-snells-window');

  // --- Upward surface crossing: this transition is time-based (fog blend/FOV/lens-wetting tween,
  // transition.ts), so it has to actually run, not be teleported across. Place just below the
  // surface, look forward/level, and ascend for real a few seconds. ---
  await page.evaluate(() => window.__diverDebug.setLook(0, -0.1));
  await page.evaluate(() => window.__diverDebug.setDepth(1.2));
  await page.waitForTimeout(300);
  await page.keyboard.down('ShiftLeft');
  await page.keyboard.down('Space');
  const ascendedDepth = await waitForDepth(page, (d) => d <= 0.3, 60_000, 500);
  await page.screenshot({ path: path.join(OUT, '09-surface-crossing-up.png') });
  snapshotErrState('09-surface-crossing-up');
  await page.waitForTimeout(800); // let the tween settle
  await page.keyboard.up('Space');
  await page.keyboard.up('ShiftLeft');
  report.leg1.ascendedDepth = ascendedDepth;
  await page.screenshot({ path: path.join(OUT, '10-surfaced.png') });
  snapshotErrState('10-surfaced');

  report.leg1.canReboard = await page.evaluate(() => !document.getElementById('reboardHint').classList.contains('hidden'));
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(800);
  report.leg1.reboarded = await page.evaluate(() => !document.getElementById('gauges').classList.contains('hidden'));
  await page.screenshot({ path: path.join(OUT, '11-reboarded.png') });
  snapshotErrState('11-reboarded');

  await page.close();
}

// ======================= Leg 2: shallow reef crest — coral + fish =======================
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  const SHALLOW_Z = chainZ(ANCHOR_X) + SHALLOW_DZ;
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await setTier(page, 'High');
  await page.click('#btnGo');
  await page.waitForTimeout(800);

  await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: ANCHOR_X, z: SHALLOW_Z });
  await page.waitForTimeout(500);

  report.leg2.residentsNearby = await page.evaluate(({ x, z }) => {
    const species = ['yellowtail', 'mangrove', 'grunt', 'barracuda', 'grouper'];
    const hits = {};
    for (const s of species) hits[s] = window.__fishDebug.findResidentNear(s, x, z, 400);
    return hits;
  }, { x: ANCHOR_X, z: SHALLOW_Z });

  await page.keyboard.press('KeyP');
  await page.waitForTimeout(300);

  // Teleport straight to depth (no reason to fight positive buoyancy for a rendering check).
  await page.evaluate(({ x, z }) => window.__diverDebug.enterAt(3, x, z, 0), { x: ANCHOR_X, z: SHALLOW_Z });
  await page.waitForTimeout(600);

  // Real game pacing: let the roaming-fish population (entities/fish/index.ts, throttled every
  // 0.4 *simulated* seconds) ramp up near the new focus point before judging "fish present".
  await page.waitForTimeout(30_000);
  report.leg2.activeSchools = await page.evaluate(() => window.__fishDebug.activeSchools());

  await page.screenshot({ path: path.join(OUT, '12-shallow-reef-coral-fish.png') });
  snapshotErrState('12-shallow-reef-coral-fish');
  report.leg2.shallowDepth = await depthM(page);
  report.leg2.profilerShallow = await profilerText(page);

  const canvas = await page.$('canvas.gl');
  await dragLook(page, canvas, 0, -245); // ~1.0 rad up
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, '13-snells-window-shallow.png') });
  snapshotErrState('13-snells-window-shallow');

  await page.close();
}

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log('--- report ---');
console.log(JSON.stringify(report, null, 2));
console.log('--- console/page errors (' + errs.length + ') ---');
for (const e of errs) console.log(e);

await browser.close();
