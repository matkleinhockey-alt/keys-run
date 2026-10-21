/**
 * End-to-end verification of Caelen's hitbox through the real game loop: dive, aim at him, fire
 * the real speargun, and watch what he does about it.
 *
 * What this proves that test/caelen.test.ts cannot: that `game/world.ts`'s frame loop actually
 * calls `life.caelenShot` with the resolved shaft's ray, and that his reaction reaches the
 * player's screen.
 *
 * Aiming goes through `__spearDebug.setLook` rather than scripted pointer drags. Drags were tried
 * first and do work (the look moves), but reading the resulting aim back costs a round trip into
 * a page running at ~3 fps in this sandbox, so a closed loop converged to a constant 12.6 deg of
 * lag — exactly one pass of his orbit — and never landed a shot. `setLook` skips the mouse and
 * nothing else: `tryFire`, the shaft's flight and the resolution path are all the real thing.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
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
const offline = page.locator('.krAuthOffline');
if (await offline.count()) { await offline.click(); await page.waitForTimeout(600); }
await page.click('#btnGo');
await page.waitForTimeout(2000);

await page.evaluate(() => window.__fishDebug.teleport(-300, 330, 0));
await page.waitForTimeout(1200);
await page.keyboard.press('KeyJ'); // dive (game/world.ts's toggleDive)
// He eases onto the dive orbit rather than snapping; this is the settled position.
await page.waitForTimeout(22000);

// Watch the toast element, so his lines are observable from out here.
await page.evaluate(() => {
  window.__toastLog = [];
  const el = document.getElementById('toast');
  if (el) new MutationObserver(() => window.__toastLog.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
});

console.log('diver mode:', await page.evaluate(() => window.__spearDebug.diverMode()));

/**
 * One shot at him. `aimOffsetY` deliberately misses by that many metres vertically, to exercise
 * the taunt as well as the hit.
 */
async function shootAt(aimOffsetY) {
  const info = await page.evaluate((dy) => {
    const c = window.__spearDebug.caelen();
    if (!c.hitbox) return { away: c.awayFor };
    const b = c.hitbox;
    const x = (b.ax + b.bx) / 2, y = (b.ay + b.by) / 2 + dy, z = (b.az + b.bz) / 2;
    window.__spearDebug.setLook(x, y, z);
    const cam = window.__spearDebug.camPos();
    return { away: c.awayFor, range: +Math.hypot(x - cam.x, y - cam.y, z - cam.z).toFixed(2) };
  }, aimOffsetY);
  if (info.range === undefined) return info;
  // One sim frame so the look reaches `diverAim.aimDir`, then fire for real.
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.__spearDebug.forceReloadReady(); window.__spearDebug.fire(); });
  await page.waitForTimeout(2500); // flight + resolution
  const after = await page.evaluate(() => ({
    away: window.__spearDebug.caelen().awayFor,
    last: (window.__toastLog ?? []).slice(-1)[0] ?? null,
  }));
  return { ...info, ...after };
}

// 1. A deliberate near miss, 1.8 m over his head — inside the taunt margin, outside the hitbox.
const miss = await shootAt(1.8);
console.log('near miss  ->', JSON.stringify(miss));

// 2. Straight at him.
let hit = null;
for (let i = 0; i < 8; i++) {
  hit = await shootAt(0);
  console.log(`shot ${i} ->`, JSON.stringify(hit));
  if (hit.away > 0) break;
}

await page.screenshot({ path: path.join(OUT, 'caelen-shot.png') });
// He must stay gone, and stay un-hittable, for the full two minutes.
const sulk = await page.evaluate(() => window.__spearDebug.caelen());
console.log('after the hit:', JSON.stringify(sulk));

const log = await page.evaluate(() => (window.__toastLog ?? []).filter((t) => t && t.includes('Caelen')));
console.log('his lines:', JSON.stringify(log));
await browser.close();
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors');
