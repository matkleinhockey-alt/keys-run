/**
 * Browser verification for A SHOT BIRD BECOMING CHUM (entities/life/carcass.ts, seabirds.ts's
 * `shootDownBird`, @keysrun/shared/sim/chum, and the feed block in entities/fish/school.ts).
 * Drives the real game, not a harness — same boot sequence and hooks as test/capture-handgun.mjs
 * (`.krAuthOffline` then `#btnGo`, then `window.__handgunDebug` / `window.__fishDebug`).
 *
 *  1. MEASURED attraction, not inferred from a screenshot. A carcass is dropped next to a real
 *     scavenger school and `__fishDebug.activeSchools()` is sampled over time: each row carries
 *     the school's centroid and its live `feed` (sim/chum.ts's own `chumPull` weight), so this
 *     records the distance from every school to the carcass and asserts the scavengers' fell and
 *     everything else's `feed` stayed at zero. A screenshot cannot distinguish "fish came to the
 *     bird" from "fish happened to be there".
 *  2. The carcass expires and nothing is left feeding on nothing.
 *  3. END TO END with the real pistol: shoot a live gull, and see a carcass appear where it lands.
 *
 * Why that order. The sandbox runs on software GL and `main.ts` reloads the page whenever the
 * WebGL context is lost, which on a loaded machine happens every couple of minutes and takes the
 * world (and every hook, and every carcass) with it. So the part that needs an unbroken window —
 * the sampling — goes first and is kept short, and the part that is cheap to retry goes last.
 * That is a harness constraint, not a statement about the game.
 *
 * Sandbox note: ~3 fps software GL and a 0.05 s sim clamp per rendered frame, so SIMULATED time
 * runs well behind wall time. Everything below polls game state rather than sleeping, the
 * simulated span is read off the carcass's own `age` rather than assumed, and nothing here makes
 * any claim about frame rate.
 *
 * Usage: CLIENT_URL=http://localhost:5474 node test/capture-bird-chum.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_URL } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || CLIENT_URL;
const OUT = path.join(HERE, 'screenshots', 'bird-chum');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(180000);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERR ' + String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/WebGL|GPU stall|favicon|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0, 300)); });

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) failures++; };
const rawClick = (sel) => page.evaluate((s) => { document.querySelector(s)?.click(); }, sel);
const H = (fn, ...a) => page.evaluate(([f, args]) => window.__handgunDebug[f](...args), [fn, a]);
const F = (fn, ...a) => page.evaluate(([f, args]) => window.__fishDebug[f](...args), [fn, a]);
/** True while the game world and its hooks are up. Goes false when `main.ts` reloads the page
 * after a lost WebGL context — see this file's header. */
const alive = () => page.evaluate(() => !!window.__fishDebug && !!window.__handgunDebug).catch(() => false);
const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

/** `every` is deliberately generous. The page renders at a few frames a second on software GL and
 * every `page.evaluate` runs on its main thread, so polling three or four times a second starves
 * the frames being waited for — which is exactly how an earlier version of this harness timed out
 * waiting for a world that was trying to boot underneath it. */
async function until(pred, what, ms = 180000, every = 1000) {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what);
    await page.waitForTimeout(every);
  }
}

async function boot() {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await page.goto(BASE, { waitUntil: 'load' });
      await page.waitForTimeout(1200);
      if (await page.locator('.krAuthOffline').count()) { await rawClick('.krAuthOffline'); await page.waitForTimeout(300); }
      await rawClick('#btnGo');
      await page.waitForTimeout(3500);
      await until(alive, 'the game world to come up', 60000, 2000);
      return;
    } catch (e) {
      console.log(`  (boot attempt ${attempt} lost the page: ${String(e).slice(0, 70)}; retrying)`);
      await page.waitForTimeout(2000);
    }
  }
  throw new Error('could not boot the game');
}
await boot();

/** sim/chum.ts's SCAVENGER_KEYS, duplicated here on purpose: the point is to check the game
 * against the stated list, so reading the list out of the code under test would make the
 * "wrong species are not attracted" assertion vacuous. */
const SCAV = ['bullshark', 'lemonshark', 'blacktip', 'tigershark', 'hammerhead',
  'barracuda', 'jackcrevalle', 'amberjack', 'cobia', 'kingfish', 'wahoo', 'tarpon', 'goliath'];

// ---------------------------------------------------------------------------------------------
console.log('\n== 1. MEASURED: scavenger schools move toward a carcass, and nothing else does ==');
check('no carcasses in the water to begin with', (await F('carcasses')).length === 0);

const schools0 = await F('activeSchools');
const scav0 = schools0.filter((s) => SCAV.includes(s.type));
console.log(`active schools: ${schools0.length}, of which scavengers: ${scav0.length} (${[...new Set(scav0.map((s) => s.type))].join(', ')})`);
check('the world has scavenger schools near the boat to test with', scav0.length > 0);
check('nothing is feeding before a carcass exists', schools0.every((s) => s.feed === 0));

// Prefer a fast species: the measurement is "did it cover ground", and at this sandbox's clock a
// goliath grouper (0.3 m/s cruise) covers about two metres in the window available.
const SPEED_ORDER = ['jackcrevalle', 'blacktip', 'bullshark', 'kingfish', 'wahoo', 'amberjack', 'tarpon', 'cobia', 'lemonshark', 'tigershark', 'hammerhead', 'barracuda', 'goliath'];
const subject = [...scav0].sort((a, b) => SPEED_ORDER.indexOf(a.type) - SPEED_ORDER.indexOf(b.type))[0];
// 25 m out along the school's own heading, so the carcass is in open water ahead of it rather than
// on top of it, and the approach has somewhere to be measured over.
const BAIT_D = 25;
const bait = { x: subject.cx - Math.sin(subject.heading) * BAIT_D, z: subject.cz - Math.cos(subject.heading) * BAIT_D };
await page.evaluate((b) => window.__fishDebug.dropCarcass(b.x, b.z), bait);
console.log(`dropped a carcass at (${bait.x.toFixed(1)}, ${bait.z.toFixed(1)}), ${BAIT_D} m from ${subject.type} ${subject.id}`);

const track = new Map(); // id -> { type, first, min, last, feedMax }
let simSpan = 0, potency0 = null, potencyEnd = null;
const sample = async () => {
  for (const s of await F('activeSchools')) {
    const d = Math.hypot(s.cx - bait.x, s.cz - bait.z);
    const e = track.get(s.id) ?? { type: s.type, first: d, min: d, last: d, feedMax: 0 };
    e.min = Math.min(e.min, d); e.last = d; e.feedMax = Math.max(e.feedMax, s.feed);
    track.set(s.id, e);
  }
  // The carcass's own age IS the simulated clock, to the frame — far better than guessing a
  // sim-to-wall ratio for a sandbox whose frame rate nothing here should claim to know.
  const c = (await F('carcasses')).find((x) => Math.hypot(x.x - bait.x, x.z - bait.z) < 1);
  if (c) { if (potency0 === null) potency0 = c.potency; potencyEnd = c.potency; simSpan = c.age; }
};
await sample();
const t0 = Date.now();
let lostIt = false;
while (Date.now() - t0 < 90000) {
  if (!(await alive())) { lostIt = true; break; }
  await sample();
  await page.waitForTimeout(1200);
}
if (lostIt) console.log('  (the page reloaded mid-sample — WebGL context loss; reporting what was collected)');
console.log(`sampled over ${simSpan.toFixed(1)} s of SIMULATED time (${((Date.now() - t0) / 1000).toFixed(0)} s of wall clock); carcass potency ${potency0} -> ${potencyEnd}`);
check('the carcass bloomed in rather than starting at full strength', potency0 !== null && potency0 < 1);

const rows = [...track.entries()].map(([id, e]) => ({ id, ...e }));
const scavRows = rows.filter((r) => SCAV.includes(r.type) && r.first < 55);
const otherRows = rows.filter((r) => !SCAV.includes(r.type));
console.log('\nscavenger schools within reach of the carcass:');
for (const r of scavRows) console.log(`  ${r.type.padEnd(13)} ${r.id.padEnd(26)} start ${r.first.toFixed(1)} m -> closest ${r.min.toFixed(1)} m (last ${r.last.toFixed(1)} m), peak feed ${r.feedMax.toFixed(3)}`);
check('a scavenger school was in reach and felt the carcass', scavRows.some((r) => r.feedMax > 0),
  JSON.stringify(scavRows.map((r) => [r.type, r.feedMax])));
const closed = scavRows.filter((r) => r.feedMax > 0 && r.min < r.first - 2);
check('a scavenger school measurably CLOSED on the carcass', closed.length > 0,
  closed.map((r) => `${r.type} ${r.first.toFixed(1)}->${r.min.toFixed(1)} m`).join('; ') || 'none closed');

const leaked = otherRows.filter((r) => r.feedMax > 0);
console.log(`\nnon-scavenger schools: ${otherRows.length} across ${[...new Set(otherRows.map((r) => r.type))].length} species; highest feed seen: ${Math.max(0, ...otherRows.map((r) => r.feedMax))}`);
check('no bait or reef school was ever drawn to the carcass', leaked.length === 0,
  leaked.map((r) => `${r.type}=${r.feedMax}`).join(', '));
if (await alive()) { await H('aimAt', bait.x, 0, bait.z); await page.waitForTimeout(2000); await shot('02-fish-over-the-carcass'); }

// ---------------------------------------------------------------------------------------------
console.log('\n== 2. the carcass ends cleanly ==');
if (!(await alive())) { console.log('  (page was lost; re-booting and re-dropping a carcass)'); await boot(); await page.evaluate((b) => window.__fishDebug.dropCarcass(b.x, b.z), bait); await page.waitForTimeout(1500); }
check('the carcass is in the water before the clock is jumped', (await F('carcasses')).length >= 1);
// Running a carcass's full two-minute life out at this sandbox's clock takes a quarter of an hour
// of wall time, so the hook jumps the clock instead — through the same `stepCarcasses` ->
// `carcassSpent` -> remove path a real frame uses.
await page.evaluate(() => window.__fishDebug.ageCarcasses(999));
await page.waitForTimeout(2000);
check('an expired carcass is gone from the water', (await F('carcasses')).length === 0, JSON.stringify(await F('carcasses')));
const after = await F('activeSchools');
check('and no school is left feeding on nothing', after.every((s) => s.feed === 0),
  JSON.stringify(after.filter((s) => s.feed > 0).map((s) => [s.type, s.feed])));
await shot('03-after-the-carcass-is-gone');

// ---------------------------------------------------------------------------------------------
console.log('\n== 3. END TO END: shoot a real gull and watch it land in the water ==');
if (!(await alive())) { console.log('  (page was lost; re-booting for the shooting test)'); await boot(); }
await H('draw');
await until(async () => (await H('state')).mode === 'gun', 'the pistol to come out', 60000);
await H('giveRounds', 300);
let landed = null, shots = 0;
for (let i = 0; i < 10 && !landed; i++) {
  if (!(await alive())) { await boot(); await H('draw'); await H('giveRounds', 300); }
  const eye = (await H('state')).eye;
  // Re-read the bird's live position and fire in the same page tick: the camera has to be aimed
  // before the shot leaves (see capture-handgun.mjs's `aimAt` comment).
  const target = await page.evaluate((e) => {
    const D = window.__handgunDebug;
    const b = D.birds().filter((x) => !x.fleeing)
      .map((x) => ({ ...x, d: Math.hypot(x.x - e.x, x.y - e.y, x.z - e.z) }))
      .filter((x) => x.d < 55).sort((a, b2) => a.d - b2.d)[0];
    if (!b) return null;
    D.aimAt(b.x, b.y, b.z);
    D.fire();
    return b;
  }, eye);
  if (!target) { await page.waitForTimeout(1500); continue; }
  shots++;
  try {
    landed = await until(async () => { const c = await F('carcasses'); return c.length ? c : null; }, 'a carcass to appear', 10000, 1000);
  } catch { /* a miss, or the shot fell short; try again */ }
}
check(`a real gull was shot down and left a carcass in the water (${shots} shots)`, !!landed,
  landed ? JSON.stringify(landed) : 'none landed');
if (landed) {
  check('the carcass is fresh — it appeared when the body landed, not when the trigger was pulled',
    landed[0].age < 5, JSON.stringify(landed[0]));
  await H('aimAt', landed[0].x, 0, landed[0].z);
  await page.waitForTimeout(2000);
}
await shot('01-carcass-on-the-water');

// ---------------------------------------------------------------------------------------------
console.log(`\npage errors: ${errs.length}`);
for (const e of errs.slice(0, 10)) console.log('  ' + e);
check('no page errors', errs.length === 0);

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURES'}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
