/**
 * End-to-end verification for rod fishing (cast → nibble → bite → strike → fight → land) and
 * spearfishing (aim → fire → hit → fight → land), screenshotted to
 * apps/client/test/screenshots/fishing/. Follows capture-screenshots.mjs's pattern: a plain
 * node script driving `playwright` directly against the Vite dev server (no playwright.config /
 * test runner in this repo yet).
 *
 * Timers here are deliberately patient — see capture-screenshots.mjs's header: this sandboxed
 * environment can render the full game scene far slower than real time (the fixed 30 Hz physics
 * accumulator is driven by each real animation frame's elapsed time, clamped to 50 ms/frame —
 * see game/world.ts's `frame()` — so a slow software-rendered frame starves the accumulator).
 * The spear harness (a bare three.js scene, no water/shadows/postfx) doesn't have this problem
 * and resolves in real time.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || 'http://localhost:5173';
const OUT = path.join(HERE, 'screenshots', 'fishing');
fs.mkdirSync(OUT, { recursive: true });

function $hidden(page, id) {
  return page.evaluate((i) => document.getElementById(i)?.classList.contains('hidden') ?? true, id);
}
function $text(page, id) {
  return page.evaluate((i) => document.getElementById(i)?.textContent ?? '', id);
}
function $widthPct(page, id) {
  return page.evaluate((i) => parseFloat(document.getElementById(i)?.style.width || '0'), id);
}
async function waitUntil(fn, timeoutMs, intervalMs = 200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Rod fishing: cast -> nibble -> bite -> strike -> fight -> land. Retries the whole cast a few
 * times (species/weight/fight difficulty are randomly rolled; an early snap/slack/spool/mangrove
 * shouldn't fail the whole verification run). */
async function captureRodFishing(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  await page.click('#btnGo');
  await page.waitForTimeout(500);

  let landed = false;
  for (let attempt = 0; attempt < 5 && !landed; attempt++) {
    // cast
    await page.keyboard.down('Space');
    await page.waitForTimeout(300); // ~30% charge — a modest, reliable cast distance
    await page.keyboard.up('Space');
    if (attempt === 0) await page.screenshot({ path: `${OUT}/rod-01-cast.png` });

    const bit = await waitUntil(() => $hidden(page, 'strike').then((h) => !h), 90000);
    if (!bit) continue; // drifted/timed out — try again
    if (attempt === 0) await page.screenshot({ path: `${OUT}/rod-02-strike.png` });

    await page.keyboard.press('Space'); // set the hook
    const hooked = await waitUntil(() => $hidden(page, 'fight').then((h) => !h), 5000);
    if (!hooked) continue;
    await page.screenshot({ path: `${OUT}/rod-03-fight.png` });

    // bang-bang drag policy, same shape as packages/shared/test/fight.test.ts's winnable case:
    // reel while tension is safe, ease off once it runs hot.
    const won = await waitUntil(async () => {
      const tension = await $widthPct(page, 'fT');
      if (tension < 78) await page.keyboard.down('ArrowDown'); else await page.keyboard.up('ArrowDown');
      if (!(await $hidden(page, 'card'))) return true; // landed
      if (await $hidden(page, 'fight')) return true; // fight ended (lost) — stop polling, checked below
      return false;
    }, 120000, 150);
    await page.keyboard.up('ArrowDown');

    landed = won && !(await $hidden(page, 'card'));
  }

  if (landed) {
    await page.screenshot({ path: `${OUT}/rod-04-landed.png` });
    const name = await $text(page, 'cName');
    const weight = await $text(page, 'cWeight');
    console.log(`[rod] landed: ${name} ${weight} lb`);
    // keep it, exercising the cooler path too
    await page.click('#btnKeep');
    await page.waitForTimeout(300);
    await page.keyboard.press('KeyQ'); // open cooler
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/rod-05-cooler.png` });
  } else {
    console.log('[rod] did not land a fish within the retry budget — see rod-03-fight.png for the last fight attempted');
  }

  console.log('[rod] page errors:', errs);
  await page.close();
  return landed;
}

/** Spearfishing: the standalone speargun harness (see test/spear-harness.ts's header for why a
 * harness rather than the full game — there is no diver/underwater mode on this branch yet). */
async function captureSpearfishing(browser) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(`${BASE}/test/spear-harness.html`, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/spear-01-aim.png` });
  await page.click('canvas');

  let landed = false;
  for (let attempt = 0; attempt < 3 && !landed; attempt++) {
    await page.keyboard.press('Space'); // fire (reload gates a re-fire automatically if needed)
    await page.waitForTimeout(120); // mid-flight (shaft travels 6 m at 25 m/s = 0.24 s)
    if (attempt === 0) await page.screenshot({ path: `${OUT}/spear-02-flight.png` });

    const speared = await waitUntil(async () => (await page.textContent('#status'))?.includes('active: true') ?? false, 5000, 100);
    if (attempt === 0) { console.log('[spear] hit registered:', speared); await page.screenshot({ path: `${OUT}/spear-03-speared.png` }); }
    if (!speared) continue;

    // Bang-bang haul policy, same shape as the rod's (and packages/shared/test/spear.test.ts's
    // winnable case): haul while tension is safe, ease off once it runs hot — holding the haul
    // down continuously is a *losing* policy here (it can tear the shaft free), by design, same
    // as the rod's own "holding the reel down continuously snaps the line".
    await waitUntil(async () => {
      const status = await page.textContent('#status');
      if (status?.includes('LANDED') || status?.includes('TORN FREE')) return true;
      const m = /tension: ([\d.-]+)/.exec(status ?? '');
      const tension = m ? parseFloat(m[1]) : 0;
      if (tension < 0.8) await page.keyboard.down('ArrowDown'); else await page.keyboard.up('ArrowDown');
      return false;
    }, 30000, 150);
    await page.keyboard.up('ArrowDown');

    landed = (await page.textContent('#status'))?.includes('LANDED') ?? false;
    if (!landed) await page.waitForTimeout(2600); // let the gun reload (SPEAR_RELOAD = 2.5 s) before retrying
  }
  await page.screenshot({ path: `${OUT}/spear-04-landed.png` });
  console.log('[spear] landed:', landed, '-', await page.textContent('#status'));

  console.log('[spear] page errors:', errs);
  await page.close();
  return landed;
}

const browser = await chromium.launch();
try {
  const spearOk = await captureSpearfishing(browser);
  const rodOk = await captureRodFishing(browser);
  console.log('--- summary ---');
  console.log('spear landed:', spearOk);
  console.log('rod landed:', rodOk);
} finally {
  await browser.close();
}
