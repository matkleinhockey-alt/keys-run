import { chromium } from 'playwright';

const URL = process.env.CLIENT_URL || 'http://localhost:5174';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(500);
await page.click('#btnGo');
await page.waitForTimeout(500);

const chainZ = (x) => 0.000012 * x * x;
const DIVE_X = 250, DIVE_DZ = 1550;
const DIVE_Z = chainZ(DIVE_X) + DIVE_DZ;
await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: DIVE_X, z: DIVE_Z });
await page.waitForTimeout(500);

await page.keyboard.press('KeyJ');
await page.waitForTimeout(500);
console.log('initial depth:', await page.textContent('#diveDepth'));

// Sprint + descend.
await page.keyboard.down('ShiftLeft');
await page.keyboard.down('KeyC');
const t0 = Date.now();
for (let i = 0; i < 16; i++) {
  await page.waitForTimeout(1000);
  const d = await page.textContent('#diveDepth');
  console.log(`real t=${((Date.now() - t0) / 1000).toFixed(1)}s depth=`, d);
}
await page.keyboard.up('KeyC');
await page.keyboard.up('ShiftLeft');

await page.screenshot({ path: '/tmp/explore-sprint-descend.png' });

// Calibrate look-pitch drag direction.
const canvas = await page.$('canvas.gl');
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx, cy - 400, { steps: 15 }); // drag pointer UP the screen
await page.mouse.up();
await page.waitForTimeout(300);
await page.screenshot({ path: '/tmp/explore-drag-up.png' });

console.log('done');
await browser.close();
