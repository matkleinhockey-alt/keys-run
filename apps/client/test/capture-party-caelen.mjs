/**
 * Verification screenshots for the two things this change adds: the moored party boats off
 * Sombrero Beach / East Sister Rock / Bamboo Key, and Caelen's hitbox once you are in the water.
 *
 * Teleports with the dev-only `__fishDebug.teleport(x,z,h)` hook rather than guessing coordinates,
 * and reads `__spearDebug.caelen()` for the live capsule — the number that distinguishes "he is
 * unreachable" from "I missed".
 *
 * This sandbox renders on a software GPU: generous waits, no fps claims.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5191';
const OUT = path.join(HERE, 'screenshots', 'party-caelen');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(900);
// The auth gate (ui/auth/gate.ts) sits over everything until you choose; solo play is what this
// verification wants.
const offline = page.locator('.krAuthOffline');
if (await offline.count()) { await offline.click(); await page.waitForTimeout(600); }
await page.click('#btnGo');
await page.waitForTimeout(2000);

// Viewpoints, not the anchorages themselves: sit 70 m seaward of each raft-up looking back at
// it, since h=0 points the boat (and the chase camera) toward -z, i.e. inshore.
const SITES = [
  ['sombrero', -300, 280 + 70, 0],
  ['east-sister-rock', 900, 626 + 70, 0],
  ['bamboo-key', 350, -1462 - 70, Math.PI],
];

for (const [name, x, z, h] of SITES) {
  await page.evaluate(([x, z, h]) => window.__fishDebug.teleport(x, z, h), [x, z, h]);
  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(OUT, `party-${name}.png`) });
  console.log('party site', name, 'captured');
}

// Close aboard the Sombrero raft-up: the detail shot — two hulls tied up, the deck party, the
// piling and the bow lines.
await page.evaluate(() => window.__fishDebug.teleport(-297, 280 + 26, 0));
await page.waitForTimeout(4000);
await page.screenshot({ path: path.join(OUT, 'party-sombrero-close.png') });

// Caelen: dive at the last site and read his capsule. He only drops into spear range once the
// player is in the water (entities/life/caelen.ts's DIVE_RADIUS/DIVE_HEIGHT), which is the whole
// reachability question this screenshot exists to answer.
await page.evaluate(() => window.__fishDebug.teleport(-300, 330, 0));
await page.waitForTimeout(1500);
await page.keyboard.press('KeyJ'); // dive (game/world.ts's toggleDive)
// He eases onto the dive orbit (`dt*0.5` lerp) rather than snapping, so this waits for the
// settled position — the transient first few seconds are not the number that matters.
await page.waitForTimeout(20000);
const before = await page.evaluate(() => window.__spearDebug?.caelen?.() ?? null);
const mode = await page.evaluate(() => window.__spearDebug?.diverMode?.() ?? null);
const cam = await page.evaluate(() => window.__spearDebug?.camPos?.() ?? null);
console.log('diver mode:', mode);
console.log('caelen:', JSON.stringify(before));
if (before?.hitbox && cam) {
  const b = before.hitbox;
  const cx = (b.ax + b.bx) / 2, cy = (b.ay + b.by) / 2, cz = (b.az + b.bz) / 2;
  console.log('distance camera -> caelen:', Math.hypot(cx - cam.x, cy - cam.y, cz - cam.z).toFixed(2), 'm (SPEAR_RANGE = 11)');
}
await page.screenshot({ path: path.join(OUT, 'caelen-diving.png') });

await browser.close();
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors');
