/**
 * Verification screenshots + measurements for the shipwrecks (entities/life/wrecks.ts).
 *
 * For each wreck: a topside shot looking down on it, a dark-mass shot from ~60 m out underwater,
 * a hull shot from ~24 m, and a fish shot; plus the minimap before/after the wreck is found. Also
 * prints, per wreck, what is actually holding on it (active schools within 90 m, and the weight
 * of every spearable fish within 40 m of the diver) - the measured version of "fish hang around".
 *
 * Usage: CLIENT_URL=http://localhost:5311 node test/capture-wrecks.mjs <out-subdir> [wreckId ...]
 * Serve THIS worktree (see the task notes: `tail -f /dev/null | pnpm exec vite --port N --strictPort`
 * from apps/client) - `pnpm --filter ... dev` from inside a worktree serves the main checkout.
 * Software GL: ~3 fps, so waits are generous and nothing here claims a frame rate.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || 'http://localhost:5311';
const TAG = process.argv[2] || 'latest';
const ONLY = process.argv.slice(3);
const OUT = path.join(HERE, 'screenshots', 'wrecks', TAG);
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(90000);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const rawClick = (sel) => page.evaluate((s) => { document.querySelector(s)?.click(); }, sel);

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(800);
if (await page.locator('.krAuthOffline').count()) { await rawClick('.krAuthOffline'); await page.waitForTimeout(200); }
await rawClick('#btnGo');
await page.waitForTimeout(1500);

const wrecks = await page.evaluate(() => window.__wreckDebug());
console.log('wrecks:', JSON.stringify(wrecks.map((w) => ({ id: w.id, x: Math.round(w.x), z: Math.round(w.z), depth: +w.depth.toFixed(1), charted: w.charted }))));

async function shootMap(name) {
  const box = await page.locator('#mapbox').boundingBox();
  await page.screenshot({ path: path.join(OUT, name), clip: box });
}

// the chart before anything is found, then enlarged
await page.evaluate(() => { try { localStorage.removeItem('keysrun.wrecks.charted.v1'); } catch { /* ignore */ } });
await page.waitForTimeout(500);
await shootMap('map-before.png');

for (const w of wrecks) {
  if (ONLY.length && !ONLY.includes(w.id)) continue;
  const fx = -Math.sin(w.heading), fz = -Math.cos(w.heading);
  const rx = -fz, rz = fx;

  // --- topside: boat parked beside it, camera high above looking down through the water ---
  await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x + 40, z + 40, 0), { x: w.x, z: w.z });
  await page.waitForTimeout(1500);
  await page.evaluate(({ x, z, len }) => { window.__fishDebugCamera = { x: x + 4, y: Math.max(60, len * 0.9), z: z + 4, lookX: x, lookY: 0, lookZ: z }; }, { x: w.x, z: w.z, len: w.len });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, `${w.id}-topside.png`) });
  await page.evaluate(() => { delete window.__fishDebugCamera; });
  const tier = await page.evaluate(() => window.__wreckDebug().map((q) => `${q.id}:${q.tier}${q.charted ? 'C' : ''}`).join(' '));
  console.log(`[${w.id}] after teleport: ${tier}`);

  // --- underwater: diver on the starboard side, looking across at the hull ---
  const top = Math.max(2.5, w.depth - w.height * 0.8);
  // [label, standoff m, depth m, pitch, along-hull fraction to aim at (0 = amidships, 0.38 = bow hold)]
  const SHOTS = (process.env.SHOTS || 'mass,hull,close,over,bow').split(',');
  for (const [label, stand, depthM, pitch, u] of [['mass', 62, top, -0.02, 0], ['hull', 24, top, -0.05, 0], ['close', 15, Math.max(2.5, w.depth - w.height * 0.5), -0.12, 0.05], ['over', 14, Math.max(2.5, w.depth - w.height - 3), -0.35, 0], ['bow', 9, Math.max(2.5, w.depth - w.height * 0.95), 0.02, 0.38]].filter((q) => SHOTS.includes(q[0]))) {
    const tx = w.x + fx * u * w.len, tz = w.z + fz * u * w.len;
    const px = tx + rx * stand, pz = tz + rz * stand;
    const yaw = Math.atan2(-(tx - px), -(tz - pz));
    await page.evaluate(({ d, x, z, yaw, pitch }) => { window.__diverDebug.enterAt(d, x, z, yaw); window.__diverDebug.setLook(yaw, pitch); }, { d: depthM, x: px, z: pz, yaw, pitch });
    await page.waitForTimeout(1800); // let terrain chunks and the wreck tier stream in
    // The diver is positively buoyant above ~10 m and drifts up at the software-GL frame rate, so
    // re-pin the depth right before the shot rather than trusting the first enterAt.
    await page.evaluate(({ d, yaw, pitch }) => { window.__diverDebug.setDepth(d); window.__diverDebug.setLook(yaw, pitch); }, { d: depthM, yaw, pitch });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, `${w.id}-${label}.png`) });
  }

  // --- measured: what is holding on it ---
  const held = await page.evaluate(({ x, z, depth }) => {
    const schools = window.__fishDebug.activeSchools().filter((s) => s.id.startsWith('wreck:') && Math.hypot(s.cx - x, s.cz - z) < 90);
    const s = window.__diverDebug.state();
    const near = s ? window.__fishDebug.spearTargetsNear(s.x, s.y, s.z, 40).filter((t) => t.id.startsWith('wreck:')) : [];
    return { schools: schools.map((q) => `${q.type}x${q.count}`), fish: near.map((t) => `${t.key} ${Math.round(t.weight)}lb`), draw: window.__wreckDebug().find((q) => q.x === x)?.tier, depth };
  }, { x: w.x, z: w.z, depth: w.depth });
  console.log(`[${w.id}] holding: ${JSON.stringify(held.schools)}\n         wreck fish within 40 m of diver: ${JSON.stringify(held.fish)}`);
  await page.evaluate(() => window.__diverDebug.exitToBoat());
  await page.waitForTimeout(800);
  await shootMap(`map-after-${w.id}.png`);
}

// enlarged chart with everything found
await rawClick('#mapbox');
await page.waitForTimeout(600);
await shootMap('map-big.png');
console.log('charted:', await page.evaluate(() => window.__wreckDebug().filter((q) => q.charted).map((q) => q.id)));
console.log('page errors:', errs);
await browser.close();
