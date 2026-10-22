/** Is it the gun, or the fish capsules? Fires at a synthetic debug capsule (radius 0.9, 2.5 m
 * straight down the aim) which is independent of fish hitbox code, then at a real fish. */
import { chromium } from 'playwright';
const PORT = process.argv[2], LABEL = process.argv[3];
const browser = await chromium.launch();

const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(`http://localhost:${PORT}`, { waitUntil: 'load' });
await page.waitForTimeout(1000);
const off = page.locator('.krAuthOffline'); if (await off.count()) { await off.click({ timeout: 180000 }); await page.waitForTimeout(1200); }
await page.click('#btnGo', { timeout: 180000 }); await page.waitForTimeout(4000);
await page.evaluate(() => window.__fishDebug.teleport(300, 900, 0));
await page.waitForTimeout(1500);
await page.keyboard.press('KeyJ');
await page.waitForTimeout(12000);

async function volley(n, setup) {
  let fired = 0, hit = 0;
  for (let i = 0; i < n; i++) {
    const ok = await page.evaluate(setup);
    if (!ok) { await page.waitForTimeout(500); continue; }
    await page.evaluate(() => { window.__spearDebug.draw?.(true); window.__spearDebug.forceReloadReady(); });
    await page.waitForTimeout(250);
    if (!await page.evaluate(() => window.__spearDebug.fire())) { await page.waitForTimeout(500); continue; }
    fired++;
    for (let w = 0; w < 14; w++) {
      await page.waitForTimeout(220);
      const s = await page.evaluate(() => ({ a: window.__spearDebug.isActive(), f: !!window.__spearDebug.fightState() }));
      if (s.f) { hit++; break; }
      if (!s.a) break;
    }
    await page.evaluate(() => window.__spearDebug.reset());
    await page.waitForTimeout(300);
  }
  return { fired, hit };
}

// 1. Synthetic capsule — independent of fish hitbox code entirely.
const synth = await volley(8, () => {
  window.__spearDebug.setSyntheticTarget({ key: 'yellowtail', weight: 3 });
  return true;
});
await page.evaluate(() => window.__spearDebug.setSyntheticTarget(null));
console.log(`[${LABEL}] SYNTHETIC capsule: ${synth.hit}/${synth.fired}`);

// 2. Real fish, aimed at capsule midpoint (no lead).
const real = await volley(12, () => {
  const t = window.__spearDebug.targets(); const cam = window.__spearDebug.camPos();
  let b = null;
  for (const c of t) { const d = Math.hypot(c.x-cam.x, c.y-cam.y, c.z-cam.z); if (d <= 9 && (!b || d < b.d)) b = { ...c, d }; }
  if (!b) return false;
  window.__spearDebug.setLook(b.x, b.y, b.z);
  return true;
});
console.log(`[${LABEL}] REAL fish (no lead): ${real.hit}/${real.fired}`);

// 3. What do the capsules look like?
const sample = await page.evaluate(() => window.__spearDebug.targets().slice(0, 4).map((t) => ({ key: t.key, r: t.radius, dist: t.dist })));
console.log(`[${LABEL}] capsule sample:`, JSON.stringify(sample));
console.log(`[${LABEL}] pageErrors=${errs.length}`);
await browser.close();
