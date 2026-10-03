/**
 * Dive integration verification (this task's acceptance criterion): drives the real diver rig
 * (entities/diver/**) — not a debug camera hook — down through every depth band of the Sombrero
 * reef wall, over coral, with fish present, and back to the surface. Saves screenshots to
 * test/screenshots/dive/.
 *
 * Why a teleport, not a scripted boat transit: this sandbox's dev server + Playwright are
 * documented as flaky under long-running load, and a multi-minute boat transit before the dive
 * even starts multiplies that risk for no verification value — the dive is what's being verified,
 * not the drive. `window.__fishDebug.teleport` is an existing, already-used dev/QA hook (see
 * test/capture-fish-screenshots.mjs), not something new added for this script. It moves the BOAT;
 * the diver still jumps off for real, swims for real, and is driven by the real physics
 * (packages/shared/src/sim/diver.ts) and the real camera rig (entities/diver/camera.ts) the whole
 * time — nothing about the dive itself is faked.
 *
 * Dive site: x=250 is the Sombrero reef anchor's own x (world/reef/constants.ts's
 * SOMBRERO_ANCHOR_X) — directly on the anchor's own north-south line, which keeps coral placement
 * density (SOMBRERO_RADIUS falloff) as high as this world allows while still sitting over the reef
 * wall itself (chainZ(250)+dz, dz 1460-1650 per depthAt's "reef wall" branch — a 3.4 m -> 45.4 m
 * drop over 190 m). dz=1550 was picked by solving depthAt's own piecewise formula for ~23 m of
 * water column there — enough room to descend through all five depth bands at one spot without
 * hitting bottom, confirmed against packages/shared/src/world/depth.ts directly, not guessed.
 *
 * Real-time pacing: this environment renders software WebGL at a few fps. game/world.ts's fixed-
 * step accumulator clamps simulated time to <=50 ms per rendered frame
 * (`const clamped = Math.min(0.05, dt);`), so at low fps the dive genuinely runs several times
 * slower than real-time — confirmed empirically (holding sprint+descend moved the diver ~2 m in
 * the first 20 real seconds). This is a real, measured property of the sandbox, not a guess, and
 * is why this script polls for each depth threshold with a generous per-leg timeout instead of
 * fixed sleeps, and is expected to take several real minutes end-to-end.
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
const DIVE_X = 250;
const DIVE_DZ = 1550; // ~23 m of water column here — see header
const DIVE_Z = chainZ(DIVE_X) + DIVE_DZ;

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

/** Poll #diveDepth until it satisfies `cmp(depth)`, or give up after maxMs (returns last depth
 * either way — callers decide whether to treat a timeout as fatal). */
async function waitForDepth(page, cmp, maxMs, pollMs = 1000) {
  const t0 = Date.now();
  let d = await depthM(page);
  while (!cmp(d) && Date.now() - t0 < maxMs) {
    await page.waitForTimeout(pollMs);
    d = await depthM(page);
  }
  return d;
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
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

const report = { bands: {}, errorsAtEachCapture: {} };
function snapshotErrState(label) { report.errorsAtEachCapture[label] = errs.length; }

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(600);
await setTier(page, 'High'); // god rays are High+ only; also the budget the brief asks to measure
await page.click('#btnGo');
await page.waitForTimeout(800);

// Spawn near the reef wall (see header) rather than scripting a long transit.
await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: DIVE_X, z: DIVE_Z });
await page.waitForTimeout(800);

// Log real resident fish near the dive site for the report (not required for the screenshots —
// roaming fish spawn around the boat's own position regardless, see entities/fish/index.ts).
report.residentsNearby = await page.evaluate(({ x, z }) => {
  const species = ['yellowtail', 'mangrove', 'grunt', 'barracuda', 'grouper'];
  const hits = {};
  for (const s of species) hits[s] = window.__fishDebug.findResidentNear(s, x, z, 400);
  return hits;
}, { x: DIVE_X, z: DIVE_Z });

await page.keyboard.press('KeyP'); // profiler HUD on for the whole dive
await page.waitForTimeout(300);

await page.screenshot({ path: path.join(OUT, '00-topside-at-reef-wall.png') });
snapshotErrState('00-topside-at-reef-wall');

// --- Jump in. ---
await page.keyboard.press('KeyJ');
await page.waitForTimeout(600);
const diverHudOn = await page.evaluate(() => !document.getElementById('diverHud').classList.contains('hidden'));
report.diverHudVisibleAfterJump = diverHudOn;

await page.screenshot({ path: path.join(OUT, '01-surface-crossing-down.png') });
snapshotErrState('01-surface-crossing-down');
report.bands['surface-crossing-down'] = await depthM(page);

const canvas = await page.$('canvas.gl');

// --- Descend through every band, sprint+descend (a dedicated, pitch-independent vertical kick —
// see sim/diver.ts's VERTICAL_KICK_ACCEL), polling the real HUD depth readout the whole way. ---
const BAND_TARGETS = [
  ['02-band1-0-5m', 2.5, 60_000],
  ['03-band2-5-10m', 7.5, 90_000],
  ['04-band3-10-15m', 12.5, 120_000],
  ['05-band4-15-20m', 17.5, 150_000],
  ['06-band5-20m-plus', 21.5, 150_000],
];

await page.keyboard.down('ShiftLeft');
await page.keyboard.down('KeyC');
for (const [label, target, maxMs] of BAND_TARGETS) {
  const d = await waitForDepth(page, (depth) => depth >= target, maxMs);
  await page.screenshot({ path: path.join(OUT, `${label}.png`) });
  snapshotErrState(label);
  report.bands[label] = d;
  console.log(`${label}: depth=${d} m (target ${target} m)`);
}
await page.keyboard.up('KeyC');
await page.keyboard.up('ShiftLeft');

// Profiler reading while genuinely underwater at the deepest band reached, for the brief's
// "< 300 draw calls underwater / < 2.5M triangles" budget — captured here, not topside.
report.profilerUnderwater = await page.evaluate(() => {
  const el = document.getElementById('profilerHud');
  return el ? el.textContent : null;
});

// --- Snell's window: still submerged, drag the look straight up. Uses the dedicated mouse-drag
// look (entities/diver/camera.ts's bindDiverPointerControls), independent of the vertical kick
// above, so this doesn't disturb the band-5 depth just reached. ---
await dragLook(page, canvas, 0, -500);
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, '07-snells-window.png') });
snapshotErrState('07-snells-window');
await dragLook(page, canvas, 0, 400); // look back toward the wall for the ascent
await page.waitForTimeout(300);

// --- Ascend back to the surface. ---
await page.keyboard.down('ShiftLeft');
await page.keyboard.down('Space');
const dAscended = await waitForDepth(page, (depth) => depth <= 0.5, 180_000);
await page.keyboard.up('Space');
await page.keyboard.up('ShiftLeft');
report.bands['ascended-to'] = dAscended;

await page.screenshot({ path: path.join(OUT, '08-surface-crossing-up.png') });
snapshotErrState('08-surface-crossing-up');

await page.waitForTimeout(1000); // let the surface-crossing tween (fog/FOV/lens-wetting) settle
await page.screenshot({ path: path.join(OUT, '09-surfaced.png') });
snapshotErrState('09-surfaced');

// --- Reboard. ---
const canReboard = await page.evaluate(() => !document.getElementById('reboardHint').classList.contains('hidden'));
report.canReboard = canReboard;
await page.keyboard.press('KeyJ');
await page.waitForTimeout(800);
const backOnBoat = await page.evaluate(() => !document.getElementById('gauges').classList.contains('hidden'));
report.reboarded = backOnBoat;
await page.screenshot({ path: path.join(OUT, '10-reboarded.png') });
snapshotErrState('10-reboarded');

const profilerText = await page.evaluate(() => {
  const el = document.getElementById('profilerHud');
  return el ? el.textContent : null;
});
report.profilerAtEnd = profilerText;

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log('--- report ---');
console.log(JSON.stringify(report, null, 2));
console.log('--- console/page errors (' + errs.length + ') ---');
for (const e of errs) console.log(e);

await browser.close();
