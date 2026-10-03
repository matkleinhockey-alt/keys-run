/**
 * Dive integration verification (this task's acceptance criterion). Drives the real diver rig
 * (entities/diver/**) — not a debug camera hook — through every required beat, saving screenshots
 * to test/screenshots/dive/.
 *
 * Approach: teleport, not a real-time swim, for everything except one honest handoff proof.
 *
 * This sandbox renders software WebGL at a couple of fps. game/world.ts's fixed-step accumulator
 * clamps simulated time to <=50 ms per rendered frame, so at a few fps real-time play runs
 * 10-40x slower than real time — measured directly in an earlier pass of this script. The dive
 * *physics* is already proven by packages/shared/test/diver.test.ts's 20 unit tests; what this
 * script verifies is the *renderer* at a given depth/position, so `window.__diverDebug`
 * (game/world.ts, same dev/QA-hook convention as the existing `__fishDebug`/`__uwDebug`) jumps
 * straight there. Leg 1 still jumps in for real and sprint-descends under actual physics for the
 * boat->diver handoff and the entry surface-crossing; the upward surface crossing is also driven
 * for a few real seconds (not teleported across) because that tween (fog/FOV/lens-wetting) is
 * itself time-based.
 *
 * Placement, precisely (not guessed): x=60, near the Sombrero reef anchor's own north-south line.
 * `depthAt(60, chainZ(60)+dz)` (packages/shared/src/world/depth.ts, no noise term applies on the
 * wall branch) was queried directly, offline, before picking these — see the table in BAND_SPOTS
 * below. The crest (dz~1460) is where the dense coral actually lives (~3.4 m); past it the wall
 * drops fast and is deliberately sparser (sponges/scattered heads on open rock), so bands 2-5 aim
 * the camera back along the slope toward the crest (or down at the local seabed) rather than
 * out into open water, which has nothing in it at any depth.
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
const X = 60;

// [label, dz, column depth at this dz (from depthAt, queried offline), diver depth, yaw, pitch, note]
const BAND_SPOTS = [
  ['02-band1-crest', 1460, 3.4, 2.5, 0, -0.3, 'on the crest — richest coral'],
  ['03-band2-upper-wall', 1485, 8.9, 7.5, 0, 0.35, 'angled up-slope, crest visible behind/above'],
  ['04-band3-wall-face', 1500, 12.2, 11.0, 0, 0.7, 'looking back and up at the wall face'],
  ['05-band4-wall-side', 1530, 18.9, 17.5, 1.4, -0.4, 'wall to one side, seabed below'],
  ['06-band5-deep', 1580, 29.9, 22.0, 0, -0.15, 'dark, wall face ahead'],
];
const CAUSTICS_SPOT = { dz: 1485, depth: 6, yaw: 0, pitch: -1.1 }; // shallow, looking steeply down
const SNELL_SPOT = { dz: 1485, depth: 8, yaw: 0, pitch: 1.0 };

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

async function profilerStats(page) {
  const txt = await page.evaluate(() => {
    const el = document.getElementById('profilerHud');
    return el ? el.textContent : null;
  });
  if (!txt) return null;
  const drawCalls = parseInt((txt.match(/draw calls\s+(\d+)/) || [])[1] || '-1', 10);
  const triangles = (txt.match(/triangles\s+([\d.]+k?)/) || [])[1] || null;
  return { drawCalls, triangles, raw: txt };
}

async function placeDiver(page, { dz, depth, yaw, pitch }) {
  const z = chainZ(X) + dz;
  await page.evaluate(({ x, z, depth, yaw }) => window.__diverDebug.enterAt(depth, x, z, yaw), { x: X, z, depth, yaw });
  await page.evaluate(({ yaw, pitch }) => window.__diverDebug.setLook(yaw, pitch), { yaw, pitch });
  await page.waitForTimeout(500); // a couple of rendered frames to settle fog/caustics uniforms
}

const errs = [];
const report = { leg1: {}, leg2: {}, errorsAtEachCapture: {}, drawCallsByCapture: {} };
function snapshotErrState(label) { report.errorsAtEachCapture[label] = errs.length; }

const browser = await chromium.launch();

// ===================== Leg 1: real handoff + entry, then teleport through bands =====================
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  // Entry point: dz=1485 (~8.9 m column — see BAND_SPOTS) so a real sprint-descend to ~5 m has
  // room before the bottom.
  const ENTRY_DZ = 1485;
  const ENTRY_Z = chainZ(X) + ENTRY_DZ;
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await setTier(page, 'High'); // god rays are High+ only; also the budget this task asks to measure
  await page.click('#btnGo');
  await page.waitForTimeout(800);

  await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: X, z: ENTRY_Z });
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
  await page.screenshot({ path: path.join(OUT, '01b-real-descent-5m.png') });
  snapshotErrState('01b-real-descent-5m');
  report.drawCallsByCapture['01b-real-descent-5m'] = await profilerStats(page);

  // --- Teleport through every band at the coordinates/aim verified against depthAt — see header.
  for (const [label, dz, colDepth, diveDepth, yaw, pitch, note] of BAND_SPOTS) {
    await placeDiver(page, { dz, depth: diveDepth, yaw, pitch });
    await page.screenshot({ path: path.join(OUT, `${label}.png`) });
    snapshotErrState(label);
    const stats = await profilerStats(page);
    report.drawCallsByCapture[label] = stats;
    report.leg1[label] = { targetDepth: diveDepth, actualDepth: await depthM(page), columnDepth: colDepth, note };
    console.log(`${label}: depth=${await depthM(page)}m (column ${colDepth}m) drawCalls=${stats && stats.drawCalls}`);
  }

  // --- Caustics close-up: shallow, looking steeply down at the seafloor/reef the pattern should
  // actually land on (depth-bands.ts: full strength 0-10 m, gone by 20 m). ---
  await placeDiver(page, CAUSTICS_SPOT);
  await page.screenshot({ path: path.join(OUT, '07-caustics-check.png') });
  snapshotErrState('07-caustics-check');
  report.drawCallsByCapture['07-caustics-check'] = await profilerStats(page);

  // --- Snell's window: shallow, looking straight up. ---
  await placeDiver(page, SNELL_SPOT);
  await page.screenshot({ path: path.join(OUT, '08-snells-window.png') });
  snapshotErrState('08-snells-window');

  // --- Upward surface crossing: this transition is time-based (fog blend/FOV/lens-wetting tween,
  // transition.ts), so it has to actually run, not be teleported across. ---
  await placeDiver(page, { dz: ENTRY_DZ, depth: 1.2, yaw: 0, pitch: -0.1 });
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

  const SHALLOW_DZ = 1460;
  const SHALLOW_Z = chainZ(X) + SHALLOW_DZ;
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await setTier(page, 'High');
  await page.click('#btnGo');
  await page.waitForTimeout(800);

  await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: X, z: SHALLOW_Z });
  await page.waitForTimeout(500);

  report.leg2.residentsNearby = await page.evaluate(({ x, z }) => {
    const species = ['yellowtail', 'mangrove', 'grunt', 'barracuda', 'grouper'];
    const hits = {};
    for (const s of species) hits[s] = window.__fishDebug.findResidentNear(s, x, z, 400);
    return hits;
  }, { x: X, z: SHALLOW_Z });

  await page.keyboard.press('KeyP');
  await page.waitForTimeout(300);

  await page.evaluate(({ x, z }) => window.__diverDebug.enterAt(2.5, x, z, 0), { x: X, z: SHALLOW_Z });
  await page.evaluate(() => window.__diverDebug.setLook(0, -0.25));
  await page.waitForTimeout(600);

  // Real game pacing: let the roaming-fish population (entities/fish/index.ts, throttled every
  // 0.4 *simulated* seconds) ramp up near the new focus point before judging "fish present".
  await page.waitForTimeout(30_000);
  report.leg2.activeSchools = await page.evaluate(() => window.__fishDebug.activeSchools());

  await page.screenshot({ path: path.join(OUT, '12-shallow-reef-coral-fish.png') });
  snapshotErrState('12-shallow-reef-coral-fish');
  report.leg2.shallowDepth = await depthM(page);
  report.drawCallsByCapture['12-shallow-reef-coral-fish'] = await profilerStats(page);

  await page.close();
}

const peak = Object.entries(report.drawCallsByCapture)
  .filter(([, v]) => v && typeof v.drawCalls === 'number')
  .sort((a, b) => b[1].drawCalls - a[1].drawCalls)[0];
report.peakDrawCalls = peak ? { label: peak[0], ...peak[1] } : null;

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log('--- report ---');
console.log(JSON.stringify(report, null, 2));
console.log('--- console/page errors (' + errs.length + ') ---');
for (const e of errs) console.log(e);

await browser.close();
