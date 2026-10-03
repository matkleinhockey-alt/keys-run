import { chromium } from 'playwright';
const URL = process.env.CLIENT_URL || 'http://localhost:5174';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(500);
await page.click('#btnGo');
await page.waitForTimeout(300);
await page.click('#wrap');

console.log('--- turning in place (A only, no W) ---');
await page.keyboard.down('KeyA');
for (let i = 0; i < 15; i++) {
  await page.waitForTimeout(500);
  const hdg = await page.textContent('#gHdg').catch(() => 'NA');
  const dep = await page.textContent('#gDep').catch(() => 'NA');
  const spd = await page.textContent('#gSpd').catch(() => 'NA');
  console.log(i, 'hdg', hdg, 'dep', dep, 'spd', spd);
}
await page.keyboard.up('KeyA');
await page.waitForTimeout(500);
console.log('--- cruising straight (W only) ---');
await page.keyboard.down('KeyW');
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  const hdg = await page.textContent('#gHdg').catch(() => 'NA');
  const dep = await page.textContent('#gDep').catch(() => 'NA');
  const spd = await page.textContent('#gSpd').catch(() => 'NA');
  console.log('B', i, 'hdg', hdg, 'dep', dep, 'spd', spd);
  if (parseFloat(dep) > 100) break;
}
await page.keyboard.up('KeyW');
await browser.close();
