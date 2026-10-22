/**
 * In-game spear hit rate on REAL fish: teleport to the shoal, dive, then repeatedly aim dead at the
 * nearest reported capsule midpoint (no lead) and fire the real gun; a hit is a fight starting.
 * Run-to-run variance is large (measured 20%..55% over 40 shots on identical code), so use >= 3
 * runs of 40. Usage: node test/verify-spear-hitrate.mjs <port> <label> [shots=40]
 * Serve with: cd apps/client && tail -f /dev/null | pnpm exec vite --port N --strictPort  (vite
 * exits when stdin closes). Do NOT use pnpm --filter from a worktree: it serves the main
 * workspace. Check /src/entities/diver/gesture.ts returns a module, not the index.html fallback.
 */
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


const N = Number(process.argv[4] || 40);
for (const name of ['real fish, aim at capsule midpoint']) {
  const real = await volley(N, () => {
    const t = window.__spearDebug.targets(); const cam = window.__spearDebug.camPos();
    let b = null;
    for (const c of t) { const d = Math.hypot(c.x-cam.x, c.y-cam.y, c.z-cam.z); if (d <= 9 && (!b || d < b.d)) b = { ...c, d }; }
    if (!b) return false;
    window.__spearDebug.setLook(b.x, b.y, b.z);
    return true;
  });
  console.log('[' + LABEL + '] ' + name + ': ' + real.hit + '/' + real.fired);
}
console.log(`[${LABEL}] pageErrors=${errs.length}`);
await browser.close();
