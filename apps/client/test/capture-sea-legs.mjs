/**
 * Verification frames for entities/crew-model/sea-legs.ts — deck crew balancing, flexing their
 * knees and swaying as the boat works in the swell. Boards the default boat at High tier, zooms
 * the chase cam onto the crew, lets the hull sit in the waves, and grabs a strip of time-spaced
 * frames. Saved to apps/client/test/screenshots/sea-legs/.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5174';
const OUT = path.join(HERE, 'screenshots', 'sea-legs');
fs.mkdirSync(OUT, { recursive: true });

async function tierLabel(page) {
  const hud = await page.textContent('#btnQuality').catch(() => '');
  if (hud && hud !== '⚙ —') return hud;
  return page.textContent('#btnQualityStart').catch(() => '');
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(800);
for (let i = 0; i < 4 && !(await tierLabel(page))?.includes('High'); i++) {
  await page.keyboard.press('KeyG');
  await page.waitForTimeout(300);
}
await page.waitForTimeout(6000);
// Offline play skips the login gate (no API server needed).
await page.getByText('Play offline').click();
await page.waitForTimeout(600);
await page.click('#btnGo');
await page.waitForTimeout(1500);
for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(30); }
await page.mouse.move(640, 400);
await page.mouse.down();
await page.mouse.move(520, 400, { steps: 10 });
await page.mouse.up();
await page.waitForTimeout(800);

for (let i = 0; i < 8; i++) {
  await page.screenshot({ path: `${OUT}/drift-${i}.png` });
  await page.waitForTimeout(700);
}
// Under way: throttle up briefly, then a hard turn, to load the knees and the lean.
await page.keyboard.down('KeyW');
await page.waitForTimeout(2500);
await page.keyboard.down('KeyA');
for (let i = 0; i < 4; i++) {
  await page.screenshot({ path: `${OUT}/turn-${i}.png` });
  await page.waitForTimeout(600);
}
await page.keyboard.up('KeyA');
await page.keyboard.up('KeyW');

console.log('errors:', errs);
await browser.close();
