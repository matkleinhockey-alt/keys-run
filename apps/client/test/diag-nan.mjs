import { chromium } from 'playwright';

const URL = process.env.CLIENT_URL || 'http://localhost:5191';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { if (m.type() === 'error' || m.text().includes('NAN-GEOM')) console.log('[console]', m.text()); });

await page.addInitScript(() => {
  window.__nanPatchDone = false;
  const tryPatch = () => {
    if (window.__nanPatchDone) return;
    if (!window.THREE && !globalThis.THREE) { /* three isn't global; patch via a different hook below */ }
  };
  tryPatch();
});

await page.goto(URL, { waitUntil: 'load' });
// Patch after module load by walking the prototype chain of any BufferGeometry instance we can find.
await page.evaluate(() => {
  // Find three's BufferGeometry via an existing mesh in the scene isn't trivial without a hook.
  // Instead, monkey-patch Object3D.prototype traversal isn't available either. Fall back: override
  // console.error to capture a stack for the specific NaN message using Error().stack at the call site
  // isn't possible after the fact. So instead we patch the global console.warn/error to print stack.
  const orig = console.error;
  console.error = function (...args) {
    if (String(args[0]).includes('Computed radius is NaN')) {
      orig.call(console, 'NAN-GEOM-STACK', new Error().stack);
    }
    return orig.apply(console, args);
  };
});
await page.waitForTimeout(800);
await page.click('#btnGo');
await page.waitForTimeout(5000);
console.log('done waiting');
await browser.close();
