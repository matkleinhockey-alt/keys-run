/**
 * Verification screenshots for the deck-crew feature (entities/crew-model/**): a chase-cam view
 * of the default boat with figures aboard, a close helm view, and a different boat (to show
 * placement varies per hull). Saved to apps/client/test/screenshots/crew/.
 *
 * Crew figures only render on High/Ultra quality (see entities/crew-model/index.ts's
 * slotCountForTier) — this sandbox's software WebGL renderer auto-detects to Low, so the script
 * force-cycles to High via the same KeyG binding capture-screenshots.mjs uses.
 *
 * This sandboxed environment renders very slowly (software/virtualized GPU), so waits are
 * generous — the asset itself is also an async glTF fetch on top of the normal boot path.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5174';
const OUT = path.join(HERE, 'screenshots', 'crew');
fs.mkdirSync(OUT, { recursive: true });

async function currentTierLabel(page) {
  // Whichever of the two quality buttons is in the visible screen (start vs HUD) has the live
  // text — the other one is hidden and stale, so don't read #btnQualityStart unconditionally
  // (it hangs on .click() once hidden post-boarding).
  const hud = await page.textContent('#btnQuality').catch(() => '');
  if (hud && hud !== '⚙ —') return hud;
  return page.textContent('#btnQualityStart').catch(() => '');
}
async function setTier(page, tierLabel) {
  let label = await currentTierLabel(page);
  for (let i = 0; i < 4 && !label?.includes(tierLabel); i++) {
    await page.keyboard.press('KeyG'); // global keydown handler, works on either screen
    await page.waitForTimeout(300);
    label = await currentTierLabel(page);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(800);
await setTier(page, 'High');

// Default boat is BOATS[1] = Grady-White (2 crew slots per placements.ts). Give the crew asset
// plenty of time to fetch + KTX2-transcode before boarding.
await page.waitForTimeout(6000);
await page.click('#btnGo');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/01-grady-chase.png` });

// Close helm view (Digit1 cycles 3rd -> Helm -> Tower -> 3rd).
await page.keyboard.press('Digit1');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/02-grady-helm.png` });
await page.keyboard.press('Digit1'); // Helm -> Tower
await page.keyboard.press('Digit1'); // Tower -> 3rd, back to chase view

// A different hull: back to the dock, pick the Freeman 42LR (3 crew slots — the biggest deck).
await page.click('#btnMarina');
await page.waitForTimeout(500);
await page.click('#boats .bcard:nth-child(3)'); // order: robalo, grady, freeman, midnight, mti
await page.waitForTimeout(300);
await page.click('#btnGo');
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/03-freeman-chase.png` });

console.log('errors:', errs);
await page.close();
await browser.close();
console.log('done');
