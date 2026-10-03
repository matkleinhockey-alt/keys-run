/**
 * Final verification screenshots (per the upgrade task's "Verification" section): start screen,
 * chase cam idle, chase cam at speed, helm view, and a sunset shot — captured at each quality
 * tier. Saved to apps/client/test/screenshots/upgraded/<tier>/.
 *
 * This sandboxed environment renders very slowly (software/virtualized GPU — see the report), so
 * waits are generous and speed/time-of-day transitions are polled rather than fixed-timed where
 * practical.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5174';
const ROOT = path.join(HERE, 'screenshots', 'upgraded');

async function waitForSpeedAbove(page, kn, timeout = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await page.textContent('#gSpd').catch(() => '0');
    if (Number(v) >= kn) return;
    await page.waitForTimeout(200);
  }
}

async function setTier(page, tierLabel) {
  let label = await page.textContent('#btnQuality');
  for (let i = 0; i < 4 && !label.includes(tierLabel); i++) {
    await page.keyboard.press('KeyG');
    await page.waitForTimeout(400);
    label = await page.textContent('#btnQuality');
  }
}

async function captureTier(browser, tierLabel, dirName) {
  const OUT = path.join(ROOT, dirName);
  fs.mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await setTier(page, tierLabel);
  await page.screenshot({ path: `${OUT}/01-start.png` });

  await page.click('#btnGo');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/02-chase-idle.png` });

  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyD');
  await waitForSpeedAbove(page, 25);
  await page.keyboard.up('KeyD');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/03-chase-speed.png` });

  await page.keyboard.press('Digit1');
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/04-helm.png` });
  await page.keyboard.press('Digit1'); // back to chase

  await page.keyboard.up('KeyW');
  await page.keyboard.press('KeyO'); // sunset
  await page.waitForTimeout(16000); // TOD transition, generous for this environment
  await page.screenshot({ path: `${OUT}/05-sunset.png` });

  console.log(`[${tierLabel}] errors:`, errs);
  await page.close();
}

const browser = await chromium.launch();
try {
  await captureTier(browser, 'Low', 'low');
  await captureTier(browser, 'Medium', 'medium');
  await captureTier(browser, 'High', 'high');
  await captureTier(browser, 'Ultra', 'ultra');
} finally {
  await browser.close();
}
console.log('done');
