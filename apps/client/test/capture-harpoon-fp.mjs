/**
 * Verification screenshots for the first-person speargun loop (entities/speargun/**): at rest,
 * mid-shot with the shaft away, and the fight meter engaged on a speared fish.
 *
 * Drives a real dive (via #btnDive, so game/world.ts's `setDiveUI` actually runs — that's what
 * makes the gun view model and diver HUD visible, not just `diver.mode`), then uses
 * `window.__diverDebug.enterAt` to jump straight to a working depth/position/look instead of
 * swimming there in real time, and `window.__spearDebug` (world.ts's debug hook, same spirit as
 * `__catchPortraitDebug`) to fire and to guarantee a hit via a synthetic target — this sandbox's
 * software-WebGL renderer runs at a measured ~2-4 fps, so "swim to a real fish and land a shot"
 * is impractical to iterate against directly (same reasoning as capture-catch-portrait.mjs's).
 *
 * Usage: node test/capture-harpoon-fp.mjs <out-subdir>
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || 'http://localhost:5199';
const TAG = process.argv[2] || 'latest';
const OUT = path.join(HERE, 'screenshots', 'harpoon', TAG);
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

async function rawClick(selector) {
  await page.evaluate((sel) => { document.querySelector(sel)?.click(); }, selector);
}

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(600);
if (await page.locator('.krAuthOffline').count()) { await rawClick('.krAuthOffline'); await page.waitForTimeout(200); }
await rawClick('#btnGo');
await page.waitForTimeout(600);

const hasHooks = await page.evaluate(() => typeof window.__diverDebug?.enterAt === 'function' && typeof window.__spearDebug?.fire === 'function');
if (!hasHooks) {
  console.error('__diverDebug/__spearDebug not found on window — is this build up to date?');
  await browser.close();
  process.exit(1);
}

// Real dive-entry (not just __diverDebug.enterAt, which only teleports — see this file's header)
// so setDiveUI actually runs and the gun view model/diver HUD show up.
await rawClick('#btnDive');
await page.waitForTimeout(300);
// (0, 1480.8) is capture-underwater.mjs's own known-clear-water depth-shot coordinate (reused
// here rather than guessed blind) — (40, 1400) first landed inside reef coral, (0, 200) turned
// out to be a shallow sandbar (surfaced instead of reaching depth). 3 m down (shallow enough that
// the underwater extinction model — world/underwater/**, not this task's to touch — hasn't
// dimmed everything toward flat fog yet; an 8 m attempt read as a view model lost in uniform
// green haze), looking dead ahead (yaw 0 = -Z, matching sim/diver.ts's convention).
await page.evaluate(() => window.__diverDebug.enterAt(3, 0, 1480.8, 0));
await page.waitForTimeout(500);

await page.screenshot({ path: `${OUT}/01-at-rest.png` });
console.log('[harpoon] 01-at-rest captured');

// Mid-shot: fire with no synthetic target (so it flies the full distance, not an instant hit)
// and grab a frame while the shaft is still in flight (SPEAR_RANGE 11 m / 25 m/s ≈ 0.44 s).
await page.evaluate(() => { window.__spearDebug.setSyntheticTarget(null); window.__spearDebug.fire(); });
await page.waitForTimeout(140);
await page.screenshot({ path: `${OUT}/02-mid-shot.png` });
const midShotActive = await page.evaluate(() => window.__spearDebug.isActive());
console.log('[harpoon] 02-mid-shot captured, speargun active:', midShotActive);

// Don't wait out the (missed) shaft's flight + the 2.5 s reload in real time: game/world.ts's
// fixed-dt accumulator clamps to 0.05 s of *simulated* time per *rendered* frame, and this
// sandbox's measured ~2-4 fps means simulated time crawls at a fraction of real wall-clock time —
// confirmed by an earlier run of this exact script, where a 3 s real wait was long enough for the
// shot's own 0.44 s simulated flight to resolve but not the reload after it (`fire()` returned
// false). `reset()`/`forceReloadReady()` (world.ts's debug hooks) sidestep that deterministically.
await page.evaluate(() => { window.__spearDebug.reset(); window.__spearDebug.forceReloadReady(); });
console.log('[harpoon] before fight shot, isActive:', await page.evaluate(() => window.__spearDebug.isActive()));

// Fight meter: guarantee a hit via the synthetic target, then let stepSpearFight run a few ticks.
await page.evaluate(() => { window.__spearDebug.setSyntheticTarget({ key: 'mutton', weight: 6.5 }); });
const fired = await page.evaluate(() => window.__spearDebug.fire());
console.log('[harpoon] fire() returned:', fired);
await page.waitForTimeout(600);
console.log('[harpoon] after wait, isActive:', await page.evaluate(() => window.__spearDebug.isActive()));
const fight = await page.evaluate(() => window.__spearDebug.fightState());
console.log('[harpoon] fight state after hit:', JSON.stringify(fight));
await page.screenshot({ path: `${OUT}/03-fight-meter.png` });
console.log('[harpoon] 03-fight-meter captured');

// Hold haul for a bit so the tension/line-out numbers visibly move before the shot.
await page.evaluate(() => window.__spearDebug.haul(true));
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/04-fight-hauling.png` });
console.log('[harpoon] 04-fight-hauling captured');

console.log('page errors:', errs);
await browser.close();
