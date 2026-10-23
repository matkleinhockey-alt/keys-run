/**
 * Trolling (+), end to end in the real game: the outriggers swing out, the boat holds seven knots
 * on its own, the spread accrues fishing credit, a strike puts the rod STRAIGHT into a fight with
 * no cast and no strike window, the fish clears the water, and toggling it off stows the poles.
 *
 * Usage:  CLIENT_URL=http://localhost:5451 node test/verify-trolling.mjs
 *
 * The strike is forced through `__fishDebug.trollStrikeNow()` rather than waited out. The soak is
 * 50-140 SIMULATED seconds by design, and this sandbox's simulated clock runs about seven times
 * slower than the wall, so an honest wait is roughly fifteen real minutes. The clock is checked
 * separately (`untilStrike` counting down) so the forcing hook is not hiding a dead timer.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'test/screenshots/_tmp-troll'; fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.setDefaultTimeout(180000);
const errs = []; p.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
await p.goto(process.env.CLIENT_URL, { waitUntil: 'load' });
await sleep(1500);
const off = await p.$('.krAuthOffline'); if (off) await off.click();
await sleep(800);
await p.click('#btnGo'); await sleep(9000);
await p.keyboard.press('KeyP');
const fail = [];
const ok = (c, m, extra = '') => { console.log((c ? 'PASS  ' : 'FAIL  ') + m + (extra ? '  ' + extra : '')); if (!c) fail.push(m); };
const T = () => p.evaluate(() => window.__fishDebug.troll());

// out into blue water so the zone table has pelagics in it
await p.evaluate(() => window.__fishDebug.teleport(1200, 2600, 0));
await sleep(5000);
ok(!(await T()).on, 'starts off', JSON.stringify(await T()));

await p.keyboard.press('Equal'); await sleep(2000);
ok((await T()).on, 'the + key turns trolling on');
await sleep(9000);
const r1 = await T();
ok(r1.rig > 0.5, 'the outriggers swing out', `rig=${r1.rig}`);
await p.screenshot({ path: `${OUT}/01-riggers-out.png` });

// the boat should come up to and hold trolling speed on its own
let best = 0;
for (let i = 0; i < 30; i++) { const s = (await T()).speed; best = Math.max(best, Math.abs(s)); if (Math.abs(s) > 3.0) break; await sleep(1500); }
const held = await T();
ok(Math.abs(held.speed) > 2.6 && Math.abs(held.speed) < 4.6, 'it holds a trolling speed with nothing held', `speed=${held.speed}`);

// the clock really is running down
const c0 = (await T()).untilStrike;
await sleep(9000);
const c1 = (await T()).untilStrike;
ok(c1 < c0, 'the spread accrues fishing credit while it is dragged', `${c0} -> ${c1}`);

// force the strike. The soak is 50-140 SIMULATED seconds and this sandbox's clock runs ~7x
// slower than the wall, so waiting one out honestly takes about fifteen real minutes.
const fired = await p.evaluate(() => window.__fishDebug.trollStrikeNow());
await sleep(2500);
const struck = await T();
ok(fired && struck.rod === 'fight', 'a fish eats and the rod goes STRAIGHT to a fight, no cast and no strike window', JSON.stringify(struck));
if (struck) {
  await p.screenshot({ path: `${OUT}/02-hooked.png` });
  // ...and it is a trolling fish, and it is big
  const got = await p.evaluate(() => window.__fishDebug.fightInfo());
  console.log('fight:', JSON.stringify(got));
  // The jump is the claim, so watch for AIRBORNE rather than for the queue: `jumpQ` is spent
  // the instant the fish leaves the water, so a fish already in the air reads 0 and the queue
  // proves nothing. (First version asserted jumpQ > 0 and failed against `airborne: true`,
  // which is the thing it was trying to establish.)
  let airborne = !!(got && got.airborne);
  for (let i = 0; i < 40 && !airborne; i++) {
    const f = await p.evaluate(() => window.__fishDebug.fightInfo());
    if (!f) break;
    if (f.airborne) airborne = true; else await sleep(700);
  }
  if (airborne) await p.screenshot({ path: `${OUT}/03-jumping.png` });
  ok(airborne && got.canJump, 'the fish clears the water off the hookup', JSON.stringify(got));
}
// turning it off stows the gear
await p.keyboard.press('Equal'); await sleep(9000);
ok((await T()).rig < 0.5, 'turning it off stows the riggers', `rig=${(await T()).rig}`);
console.log('page errors:', errs.length ? errs.slice(0, 3) : 'none');
await b.close();
console.log(fail.length ? `FAILURES: ${fail.join(' | ')}` : 'ALL CHECKS PASSED');
process.exitCode = fail.length ? 1 : 0;
