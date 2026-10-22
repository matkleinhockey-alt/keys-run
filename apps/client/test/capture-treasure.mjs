/**
 * Verification screenshots + measurements for treasure in the wrecks
 * (entities/life/wreck-treasure.ts, rules in @keysrun/shared/sim/treasure).
 *
 * Per wreck: a wide shot of a container in the sand beside the hull, a close shot with the "F
 * Prise open the ..." prompt up, and the same container after it has been opened. Also prints what
 * every container is and pays, the wallet before and after each open, and the pistol's round count
 * before and after — the measured version of "loot and ammo".
 *
 * Usage: CLIENT_URL=http://localhost:5472 node test/capture-treasure.mjs <out-subdir> [wreckId ...]
 * Serve THIS worktree (`tail -f /dev/null | pnpm exec vite --port N --strictPort` from
 * apps/client); `pnpm --filter ... dev` inside a worktree serves the main checkout instead.
 * Software GL: ~3 fps, so the waits are generous and nothing here claims a frame rate. Even so the
 * seabed chunks around a teleported diver sometimes have not streamed in by the time the shutter
 * goes, and a container then photographs as if it were floating in open water. It is not: the
 * frames in screenshots/treasure/verify where the sand IS drawn (dc3-coins-*) show it sitting in
 * the sand. If a shot looks wrong, take it again before believing it.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || 'http://localhost:5472';
const TAG = process.argv[2] || 'latest';
const ONLY = process.argv.slice(3);
const OUT = path.join(HERE, 'screenshots', 'treasure', TAG);
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
// Start every run with every wreck full, or a second run has nothing to open.
await page.evaluate(() => { try { localStorage.removeItem('keysrun.treasure.v1'); } catch { /* ignore */ } });
await page.reload({ waitUntil: 'load' });
await page.waitForTimeout(800);
if (await page.locator('.krAuthOffline').count()) { await rawClick('.krAuthOffline'); await page.waitForTimeout(200); }
await rawClick('#btnGo');
await page.waitForTimeout(1500);

const wrecks = await page.evaluate(() => window.__wreckDebug());
const all = await page.evaluate(() => window.__treasureDebug.state());
console.log(`containers: ${all.containers.length}, total cash $${all.containers.reduce((s, c) => s + c.cash, 0)}, total ammo ${all.containers.reduce((s, c) => s + c.ammo, 0)}`);
for (const c of all.containers) console.log(`  ${c.id.padEnd(14)} ${c.kind.padEnd(10)} $${String(c.cash).padStart(5)} ${String(c.ammo).padStart(3)}r  at ${c.x},${c.z} y=${c.y}`);

const cash = () => page.evaluate(() => document.getElementById('scCash')?.textContent ?? '?');
const ammo = () => page.evaluate(() => window.__treasureDebug.rounds());

for (const w of wrecks) {
  if (ONLY.length && !ONLY.includes(w.id)) continue;
  const mine = all.containers.filter((c) => c.id.startsWith(w.id + ':'));
  if (!mine.length) continue;
  // KIND=ammocan proves the other half of a payout (rounds into the inventory); the default is
  // the strongbox, which every wreck has.
  const wantKind = process.env.KIND || 'strongbox';
  const c = mine.find((q) => q.kind === wantKind) ?? mine[0];

  // Boat parked beside the wreck so the terrain and the hull stream in.
  await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x + 30, z + 30, 0), { x: w.x, z: w.z });
  await page.waitForTimeout(1500);

  for (const [label, stand, up, pitch] of [['wide', 10, 3.2, -0.34], ['close', 2.8, 1.15, -0.42]]) {
    // Stand off toward the open sand (away from the hull), looking back at the box.
    const ax = c.x - w.x, az = c.z - w.z;
    const l = Math.hypot(ax, az) || 1;
    const px = c.x + (ax / l) * stand, pz = c.z + (az / l) * stand;
    const yaw = Math.atan2(-(c.x - px), -(c.z - pz));
    const depth = -(c.y + up);
    await page.evaluate(({ d, x, z, yaw, pitch }) => {
      window.__diverDebug.enterAt(d, x, z, yaw);
      window.__diverDebug.setLook(yaw, pitch);
    }, { d: depth, x: px, z: pz, yaw, pitch });
    // Generous: on a software GL at ~3 fps the seabed chunks around a teleported diver take
    // several seconds to stream in, and a screenshot taken before they do shows a strongbox
    // apparently floating in open water (it is not - see the same frame five seconds later).
    await page.waitForTimeout(4000);
    await page.evaluate(({ d, yaw, pitch }) => { window.__diverDebug.setDepth(d); window.__diverDebug.setLook(yaw, pitch); }, { d: depth, yaw, pitch });
    await page.waitForTimeout(3000);
    const prompt = await page.evaluate(() => {
      const el = document.getElementById('lootPrompt');
      return el && !el.classList.contains('hidden') ? `${el.classList.contains('far') ? '[far] ' : ''}${el.textContent}` : null;
    });
    const reach = await page.evaluate(() => window.__treasureDebug.state().reach);
    console.log(`[${w.id}] ${label}: prompt=${JSON.stringify(prompt)} reach=${JSON.stringify(reach)}`);
    await page.screenshot({ path: path.join(OUT, `${w.id}-${c.kind}-${label}.png`) });
  }

  // Open it by pressing the key a player presses — not the debug hook — so this also proves the
  // binding survives whatever else is listening for F (the dock's tie-up hook, mainly).
  const before = await cash();
  const beforeAmmo = await ammo();
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(1500);
  const opened = await page.evaluate(() => window.__treasureDebug.state().opened);
  const toast = await page.evaluate(() => document.getElementById('toast')?.textContent ?? '');
  const afterCash = await cash(), afterAmmo = await ammo();
  console.log(`[${w.id}] F pressed; opened=${JSON.stringify(opened)}; cash ${before} -> ${afterCash}; rounds ${beforeAmmo} -> ${afterAmmo}; toast: ${toast}`);
  await page.screenshot({ path: path.join(OUT, `${w.id}-${c.kind}-opened.png`) });
  // And again: an emptied container must not pay twice.
  await page.keyboard.press('KeyF');
  await page.waitForTimeout(1200);
  const stillCash = await cash();
  console.log(`[${w.id}] F again; cash still ${stillCash}; toast: ${await page.evaluate(() => document.getElementById('toast')?.textContent ?? '')}`);

  await page.evaluate(() => window.__diverDebug.exitToBoat());
  await page.waitForTimeout(600);
}

console.log('opened at end:', await page.evaluate(() => window.__treasureDebug.state().opened));
console.log('page errors:', errs);
await browser.close();
