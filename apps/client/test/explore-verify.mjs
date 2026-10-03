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

await page.keyboard.down('ShiftLeft');
await page.keyboard.down('KeyC');
await page.waitForTimeout(15000);
await page.keyboard.up('KeyC');
await page.keyboard.up('ShiftLeft');

console.log('depth:', await page.textContent('#diveDepth'));
await page.screenshot({ path: '/tmp/verify-mask-view.png' });

await browser.close();
