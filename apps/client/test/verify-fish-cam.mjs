/**
 * The fish cam: does it fire on the hookset, go UNDER the water, move, and give the camera back?
 *
 * Usage:  CLIENT_URL=http://localhost:5451 node test/verify-fish-cam.mjs
 *
 * Two things about measuring a 2.3 second shot in a sandbox that renders at about two frames a
 * second, both of which produced wrong answers before they were understood:
 *
 *  - Every `page.evaluate` is a round trip costing roughly a frame, so reading the cam state and
 *    the camera position separately sampled them several frames apart — usually after the shot
 *    had already handed the camera back, which read as "it went above water and barely moved"
 *    when it had simply finished. They are fetched in ONE call now.
 *  - A screenshot costs about the same, so the shot is held open with `__fishDebug.fishCamHold`
 *    purely so there is something left to photograph. The timing checks all run against the real
 *    2.3 s shot; only the picture uses the hold.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'test/screenshots/_tmp-fishcam'; fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.setDefaultTimeout(180000);
const errs = []; p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
await p.goto(process.env.CLIENT_URL, { waitUntil: 'load' });
await sleep(1500);
const off = await p.$('.krAuthOffline'); if (off) await off.click();
await sleep(800);
const tier = async () => {
  const hud = await p.textContent('#btnQuality').catch(() => '');
  if (hud && hud !== '⚙ —') return hud;
  return p.textContent('#btnQualityStart').catch(() => '');
};
for (let i = 0; i < 5; i++) { if (/High/i.test(await tier() || '')) break; await p.keyboard.press('KeyG'); await sleep(500); }
await p.click('#btnGo'); await sleep(10000);
await p.keyboard.press('KeyP');
const fail = [];
const ok = (c, m, extra = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + m + (extra ? '  ' + extra : '')); if (!c) fail.push(m); };
const cam = () => p.evaluate(() => window.__fishDebug.fishCam());
const camPos = () => p.evaluate(() => window.__landDebug.camera());

await p.evaluate(() => window.__fishDebug.teleport(1200, 2600, 0));
await sleep(5000);
ok(!(await cam()).active, 'idle before anything is hooked');

const before = await camPos();
await p.keyboard.press('Digit7'); await sleep(9000);   // trolling, so the hookup needs no timing
const fired = await p.evaluate(() => window.__fishDebug.trollStrikeNow());
ok(fired, 'a trolling strike hooks up');
// ONE round trip. Each `evaluate` costs ~0.5 s at this sandbox's ~2 fps and the whole shot is
// 2.3 s, so reading the state and the camera separately sampled them several frames apart —
// and often after the shot had already handed the camera back, which read as "it went above
// water and barely moved" when it had simply finished.
await sleep(300);
const snap = await p.evaluate(() => ({ cam: window.__fishDebug.fishCam(), pos: window.__landDebug.camera() }));
const c1 = snap.cam, p1 = snap.pos;
ok(c1.active, 'the fish cam cuts in on the hookset', JSON.stringify(c1));
ok(p1.y < -0.4, 'and it is UNDER the water', `y=${p1.y}`);
ok(Math.hypot(p1.x - before.x, p1.z - before.z) > 3, 'and the camera actually goes somewhere', `${before.x},${before.z} -> ${p1.x},${p1.z}`);
console.log('camera during shot:', JSON.stringify(p1), 'fish:', JSON.stringify(await p.evaluate(() => { const f = window.__fishDebug.fightInfo(); const s = window.__fishDebug.troll(); return { f, s }; })));
console.log('water at fish:', JSON.stringify(await p.evaluate(() => { const st = window.__fishDebug.boatState(); return window.__fishDebug.waterColumnAt(st.x, st.z, performance.now() / 1000); })));
// Mid-shot, not on the cut: the surface-crossing transition (world/underwater/transition.ts)
// eases over ~0.3 s, so a frame grabbed at 0.4 s is half above and half below the water and
// tells you nothing about what the shot looks like.
// Hold the shot open so it can actually be photographed — see FishCam.trigger's `holdS`.
await p.evaluate(() => window.__fishDebug.fishCamHold(25));
await sleep(2500);
await p.screenshot({ path: `${OUT}/01-fishcam.png` });
await sleep(2500);
console.log('held shot camera:', JSON.stringify(await p.evaluate(() => window.__landDebug.camera())));
const p2 = (await p.evaluate(() => ({ pos: window.__landDebug.camera() }))).pos;
ok(Math.hypot(p2.x - p1.x, p2.z - p1.z) > 0.3, 'it moves during the shot rather than sitting still', `d=${Math.hypot(p2.x - p1.x, p2.z - p1.z).toFixed(2)}`);
await p.screenshot({ path: `${OUT}/02-fishcam-later.png` });

for (let i = 0; i < 30; i++) { if (!(await cam()).active) break; await sleep(500); }
ok(!(await cam()).active, 'and it gives the camera back');
console.log('page errors:', errs.length ? errs.slice(0, 3) : 'none');
await b.close();
console.log(fail.length ? `FAILURES: ${fail.join(' | ')}` : 'ALL CHECKS PASSED');
process.exitCode = fail.length ? 1 : 0;
