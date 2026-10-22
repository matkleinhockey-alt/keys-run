/**
 * Cruise control (6), end to end in the real game: that it opens the throttle with nothing held,
 * that it SURVIVES a tap of W, that astern drops it like a brake, that toggling it off actually
 * lets the boat coast down, and that going over the side drops it.
 *
 * Usage:  CLIENT_URL=http://localhost:5451 node test/verify-cruise.mjs
 *
 * The coast-down checks are the ones that matter and the reason this is a real-game harness
 * rather than a unit test: the first version latched `fwd` and never un-latched it, so cancelling
 * cruise left the throttle wide open — the lamp went out, the player had nothing held, and the
 * boat kept accelerating to its top speed (measured 33.7 -> 36.5 -> 38.6 m/s). Nothing about
 * that is visible in the input module's own state; you have to watch the boat.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'test/screenshots/_tmp-cruise'; fs.mkdirSync(OUT, { recursive: true });
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
const spd = () => p.evaluate(() => window.__fishDebug.boatState().speed);
const lamp = () => p.evaluate(() => !!document.getElementById('cruiseLamp')?.classList.contains('on'));
const fail = [];
const ok = (c, m, extra = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + m + (extra ? '  ' + extra : '')); if (!c) fail.push(m); };

ok(Math.abs(await spd()) < 0.5, 'starts stopped', `speed=${(await spd()).toFixed(2)}`);
ok(!(await lamp()), 'cruise lamp is hidden before it is used');

await p.keyboard.press('Digit6'); await sleep(6000);
const cruising = await spd();
ok(cruising > 2, 'pressing 6 gets the boat under way with nothing held', `speed=${cruising.toFixed(2)}`);
ok(await lamp(), 'the cruise lamp is lit while latched');
await p.screenshot({ path: `${OUT}/01-cruising.png` });

await sleep(6000);
ok((await spd()) >= cruising - 0.5, 'it stays under way without a key down', `speed=${(await spd()).toFixed(2)}`);

// a tap of W must not cancel it
await p.keyboard.down('KeyW'); await sleep(600); await p.keyboard.up('KeyW'); await sleep(3000);
ok(await lamp(), 'a tap of W does not drop cruise');
ok((await spd()) > 2, 'and the boat is still moving', `speed=${(await spd()).toFixed(2)}`);

// astern is the brake. Compare against the speed RIGHT BEFORE the brake, not the first reading
// after latching — the boat is still accelerating toward its terminal speed at that point, so
// the early number is not a baseline for anything.
const beforeBrake = await spd();
await p.keyboard.down('KeyS'); await sleep(900); await p.keyboard.up('KeyS'); await sleep(5000);
ok(!(await lamp()), 'astern drops cruise, like a brake');
const after = await spd();
ok(after < beforeBrake, 'and the boat slows once it is dropped', `${beforeBrake.toFixed(2)} -> ${after.toFixed(2)}`);

// toggling off
await p.keyboard.press('Digit6'); await sleep(3000);
ok(await lamp(), '6 latches again');
await p.keyboard.press('Digit6'); await sleep(5000);
ok(!(await lamp()), '6 again drops it');
const coast = await spd();
await sleep(6000);
ok((await spd()) < coast, 'and it coasts down rather than holding speed', `${coast.toFixed(2)} -> ${(await spd()).toFixed(2)}`);

// diving must drop it
await p.keyboard.press('Digit6'); await sleep(2500);
await p.keyboard.press('KeyJ'); await sleep(4000);
ok(!(await lamp()), 'going over the side drops cruise');

console.log('page errors:', errs.length ? errs.slice(0, 3) : 'none');
await b.close();
console.log(fail.length ? `FAILURES: ${fail.join(' | ')}` : 'ALL CHECKS PASSED');
process.exitCode = fail.length ? 1 : 0;
