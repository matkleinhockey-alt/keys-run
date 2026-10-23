/**
 * Pistol aiming: mouse look while the pointer is locked, and the press-and-drag fallback when a
 * browser refuses the lock.
 *
 * This sandbox cannot grant pointer lock at all — `requestPointerLock()` throws
 * `WrongDocumentError: The root document of this element is not valid for pointer lock`, because
 * headless Chromium has no top-level browsing context it will lock to. So the locked branch is
 * exercised by overriding `document.pointerLockElement` and dispatching pointer events with real
 * `movementX/Y`: that is this module's own logic end to end, with only the browser's lock itself
 * stubbed. The fallback branch is driven with genuine mouse input.
 */
import { chromium } from 'playwright';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.setDefaultTimeout(180000);
const errs = []; p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
await p.goto(process.env.CLIENT_URL, { waitUntil: 'load' });
await sleep(1500);
const off = await p.$('.krAuthOffline'); if (off) await off.click();
await sleep(800);
await p.click('#btnGo'); await sleep(8000);
await p.keyboard.press('KeyP');
const fail = [];
const ok = (c, m, extra = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + m + (extra ? '  ' + extra : '')); if (!c) fail.push(m); };
const st = () => p.evaluate(() => window.__handgunDebug.state());
const look = async () => (await st()).look;
const shots = async () => (await st()).tally.shots;

await p.keyboard.press('Digit9'); await sleep(2500);
// the pistol draws with an empty magazine and reloads itself — wait for a round, or every
// "did it fire" check below is really just measuring the reload timer
for (let i = 0; i < 40; i++) { if ((await st()).mag > 0) break; await sleep(1000); }
ok((await st()).mag > 0, 'the pistol has a round chambered before any firing is measured', `mag=${(await st()).mag}`);

// ---- 1. fallback: press-and-drag aims, a clean click fires -------------------------------
const a0 = await look();
await p.mouse.move(640, 360); await p.mouse.down();
await p.mouse.move(760, 400, { steps: 6 }); await p.mouse.up(); await sleep(1500);
const a1 = await look();
ok(Math.abs(a1.yaw - a0.yaw) > 0.01, 'fallback: press-and-drag still aims', `${a0.yaw.toFixed(3)} -> ${a1.yaw.toFixed(3)}`);
const s0 = await shots();
await p.mouse.move(640, 360); await p.mouse.down(); await p.mouse.up(); await sleep(2000);
ok((await shots()) > s0, 'fallback: a clean click still fires', `${s0} -> ${await shots()}`);

// ---- 2. locked: the mouse aims with NO button held ----------------------------------------
await p.evaluate(() => {
  const cv = document.querySelector('canvas.gl') || document.querySelector('canvas');
  Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => cv });
});
const b0 = await look();
await p.evaluate(() => {
  const cv = document.querySelector('canvas.gl') || document.querySelector('canvas');
  for (let i = 0; i < 10; i++) {
    cv.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, bubbles: true, movementX: 14, movementY: 3 }));
  }
});
await sleep(1500);
const b1 = await look();
ok(Math.abs(b1.yaw - b0.yaw) > 0.05, 'locked: moving the mouse with NO button held aims', `${b0.yaw.toFixed(3)} -> ${b1.yaw.toFixed(3)}`);

const s1 = await shots();
await p.evaluate(() => {
  const cv = document.querySelector('canvas.gl') || document.querySelector('canvas');
  cv.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, bubbles: true }));
});
await sleep(2000);
ok((await shots()) > s1, 'locked: a click fires straight from pointerdown', `${s1} -> ${await shots()}`);

await p.evaluate(() => { Object.defineProperty(document, 'pointerLockElement', { configurable: true, get: () => null }); });
console.log('page errors:', errs.length ? errs.slice(0, 3) : 'none');
await b.close();
console.log(fail.length ? `FAILURES: ${fail.join(' | ')}` : 'ALL CHECKS PASSED');
process.exitCode = fail.length ? 1 : 0;
