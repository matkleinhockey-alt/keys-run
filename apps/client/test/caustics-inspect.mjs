import { chromium } from 'playwright';

const URL = process.env.CLIENT_URL || 'http://localhost:5174';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(600);
let label = await page.textContent('#btnQuality');
for (let i = 0; i < 4 && !label.includes('High'); i++) {
  await page.keyboard.press('KeyG');
  await page.waitForTimeout(300);
  label = await page.textContent('#btnQuality');
}
await page.click('#btnGo');
await page.waitForTimeout(800);

await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: 60, z: 1460 });
await page.waitForTimeout(500);
await page.evaluate(() => {
  window.__fishDebugCamera = { x: 60, y: -1.2, z: 1460, lookX: 68, lookY: -3.4, lookZ: 1472 };
});
await page.waitForTimeout(600);

const a = await page.evaluate(() => window.__uwInspect());
await page.waitForTimeout(500);
const b = await page.evaluate(() => window.__uwInspect());

console.log('sample A:', JSON.stringify(a, null, 2));
console.log('sample B (500ms later):', JSON.stringify(b, null, 2));

await browser.close();
