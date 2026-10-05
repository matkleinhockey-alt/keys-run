/**
 * Verification for feat/spearable-fish (Problems 1-3 of this task's brief):
 *
 *  1. getSpearTargets() now returns real per-fish capsules (entities/fish/index.ts's
 *     `spearTargetsNear`) instead of one capsule per school at the diver's own Y. Proven by
 *     aiming a *real* (non-synthetic) shot at a live fish's own reported capsule and confirming
 *     it connects through the actual production hit-test (`stepSpear`), not a re-implementation.
 *     Everything from "read the live capsule" to "fire" happens inside a single `page.evaluate`
 *     call so there is no Playwright round-trip latency between aiming and firing — fish keep
 *     swimming/wiggling every simulated frame (school.ts), so any gap here is real aim error, not
 *     a geometry bug. A slow, large, solitary species (goliath grouper) is used for this specific
 *     check so its own swim-wiggle amplitude (~0.3 m, school.ts's per-member sin wobble) is small
 *     relative to its capsule radius (~0.5 m) — a small fast-schooling fish (yellowtail, radius
 *     ~0.12 m) is comparably sized *to* its own wiggle, which is a real gameplay property (small
 *     fish are twitchy targets), not something this check needs to fight.
 *  2. A missed shot that passes close to a real fish spooks it (and its school) via a transient
 *     `Threat.kind:'spear'`. Proven on a *fresh* school (confirmed `flee === 0` immediately before
 *     the shot) by firing just outside that fish's own capsule radius (a guaranteed geometric
 *     miss, confirmed by `fightState()` staying null) but inside the near-miss margin, then
 *     reading `debugActiveSchools()`'s `flee` field — a direct signal from school.ts's own flee
 *     state, not an inference from position deltas. A wide-miss negative control on a second
 *     fresh school confirms firing far away does *not* spook it.
 *  3. Underwater density/variety — screenshots across a few spots plus real `debugPoolStats()`
 *     numbers (draw calls/triangles), honestly reported, not guessed.
 *
 * Usage: node test/capture-spearable-fish.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || 'http://localhost:5340';
const OUT = path.join(HERE, 'screenshots', 'spearable');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(60000);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

async function rawClick(selector) {
  await page.evaluate((sel) => { document.querySelector(sel)?.click(); }, selector);
}

await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(600);
if (await page.locator('.krAuthOffline').count()) { await rawClick('.krAuthOffline'); await page.waitForTimeout(200); }
await rawClick('#btnGo');
await page.waitForTimeout(600);

const hasHooks = await page.evaluate(() =>
  typeof window.__diverDebug?.enterAt === 'function' &&
  typeof window.__spearDebug?.fire === 'function' &&
  typeof window.__fishDebug?.spearTargetsNear === 'function',
);
if (!hasHooks) {
  console.error('required debug hooks not found on window — is this build up to date?');
  await browser.close();
  process.exit(1);
}

await rawClick('#btnDive');
await page.waitForTimeout(300);

const REEF_ORIGIN = { x: 0, z: 1550 };

/** Finds `key` near `originX,originZ`, jumps the diver in nearby, and waits for resident/roamer
 * activation to settle (SPAWN_THROTTLE_S runs on simulated time, which crawls slowly here). */
async function approach(key, originX, originZ, radius) {
  const hit = await page.evaluate(
    ({ key, x, z, radius }) => window.__fishDebug.findResidentNear(key, x, z, radius),
    { key, x: originX, z: originZ, radius },
  );
  if (!hit) return null;
  const col = await page.evaluate(({ x, z }) => window.__fishDebug.waterColumnAt(x, z, performance.now() / 1000), hit);
  const depth = Math.max(1, -(col.floor + (col.surf - col.floor) * 0.55));
  await page.evaluate(({ depth, x, z }) => window.__diverDebug.enterAt(depth, x, z + 10, 0), { depth, x: hit.x, z: hit.z });
  await page.waitForTimeout(3500);
  return hit;
}

/**
 * Everything from "read the live capsule nearest `key`" to "fire" runs inside one evaluate call —
 * see this file's header. `lateralOffset` m is added perpendicular to the aim (in the horizontal
 * plane, at the fish's own depth) before firing: 0 for a dead-on shot, `radius + margin` for a
 * deliberate near-miss. Returns the capsule read, the computed geometry, and fire()'s result.
 */
async function aimAndFire(key, lateralOffset, standoffM = 5) {
  return page.evaluate(({ key, lateralOffset, standoffM }) => {
    const diver = window.__diverDebug.state();
    const targets = window.__fishDebug.spearTargetsNear(diver.x, diver.y, diver.z, 30).filter((t) => t.key === key);
    if (targets.length === 0) return { found: false };
    let best = targets[0], bestD = Infinity;
    for (const t of targets) {
      const mx = (t.ax + t.bx) / 2, my = (t.ay + t.by) / 2, mz = (t.az + t.bz) / 2;
      const d = Math.hypot(mx - diver.x, my - diver.y, mz - diver.z);
      if (d < bestD) { bestD = d; best = t; }
    }
    const mid = { x: (best.ax + best.bx) / 2, y: (best.ay + best.by) / 2, z: (best.az + best.bz) / 2 };
    // Diver placed standoffM behind the fish (same Y, +Z side), target point offset laterally in
    // +X by lateralOffset — see aimAndFire's own doc comment.
    const P = { x: mid.x, y: mid.y, z: mid.z + standoffM };
    const T = { x: mid.x + lateralOffset, y: mid.y, z: mid.z };
    const yaw = Math.atan2(-(T.x - P.x), -(T.z - P.z));
    window.__diverDebug.enterAt(-P.y, P.x, P.z, yaw);
    window.__spearDebug.setSyntheticTarget(null);
    window.__spearDebug.reset();
    window.__spearDebug.forceReloadReady();
    const fired = window.__spearDebug.fire();
    return { found: true, id: best.id, radius: best.radius, weight: best.weight, catchable: best.catchable, mid, standoffM, lateralOffset, fired };
  }, { key, lateralOffset, standoffM });
}

async function schoolFleeFor(schoolId) {
  const schools = await page.evaluate(() => window.__fishDebug.activeSchools());
  return schools.find((s) => s.id === schoolId) ?? null;
}

// --- Problem 1: a real, non-synthetic shot connects on a real fish's own reported capsule --------
console.log('--- Problem 1: real per-fish capsule alignment ---');
let bigFish = await approach('goliath', REEF_ORIGIN.x, REEF_ORIGIN.z, 2600);
if (!bigFish) { console.log('[spearable] no goliath resident found; falling back to grouper'); bigFish = await approach('grouper', REEF_ORIGIN.x, REEF_ORIGIN.z, 2600); }
let hitKey = bigFish ? (await page.evaluate(() => window.__fishDebug.activeSchools()).then((s) => s.find((x) => x.type === 'goliath' || x.type === 'grouper')?.type)) : null;
console.log('[spearable] hit-test species:', hitKey, 'anchor:', JSON.stringify(bigFish));

if (bigFish && hitKey) {
  await page.screenshot({ path: `${OUT}/01-approach-big-fish.png` });
  const r1 = await aimAndFire(hitKey, 0, 4);
  console.log('[spearable] dead-on aim/fire result:', JSON.stringify(r1));
  await page.screenshot({ path: `${OUT}/02-aimed-fire.png` });
  await page.waitForTimeout(2000);
  const active1 = await page.evaluate(() => window.__spearDebug.isActive());
  const fight1 = await page.evaluate(() => window.__spearDebug.fightState());
  console.log('[spearable] after dead-on real shot — isActive:', active1, 'fightState:', JSON.stringify(fight1));
  await page.screenshot({ path: `${OUT}/03-result.png` });
  if (fight1 && fight1.outcome) {
    console.log(`[spearable] PASS — a real shot aimed at spearTargetsNear's own reported capsule (${hitKey}, radius ${r1.radius?.toFixed(2)} m) connected: fight outcome "${fight1.outcome}".`);
  } else {
    console.log('[spearable] FAIL/NOTE: dead-on real shot did not connect — see result objects above.');
  }
  await page.evaluate(() => { window.__spearDebug.reset(); window.__spearDebug.forceReloadReady(); });
} else {
  console.log('[spearable] FAIL/NOTE: could not find a goliath or grouper resident near REEF_ORIGIN to run the hit-test against.');
}

// --- Problem 2: a clean near-miss spooks the fish's own school, a wide miss does not -------------
console.log('--- Problem 2: near-miss flee response ---');
const schoolA = await approach('yellowtail', REEF_ORIGIN.x, REEF_ORIGIN.z, 1200);
if (schoolA) {
  await page.screenshot({ path: `${OUT}/04-approach-school.png` });
  // Identify the target school id + confirm a clean (flee===0) baseline before firing anything.
  const probe = await page.evaluate(({ key }) => {
    const diver = window.__diverDebug.state();
    const t = window.__fishDebug.spearTargetsNear(diver.x, diver.y, diver.z, 30).find((x) => x.key === key);
    return t ? { ax: t.ax, ay: t.ay, az: t.az, bx: t.bx, by: t.by, bz: t.bz, radius: t.radius } : null;
  }, { key: 'yellowtail' });
  const schools0 = await page.evaluate(() => window.__fishDebug.activeSchools());
  const mid = probe ? { x: (probe.ax + probe.bx) / 2, z: (probe.az + probe.bz) / 2 } : null;
  const targetSchool = mid ? schools0.filter((s) => s.type === 'yellowtail').sort((a, b) => Math.hypot(a.cx - mid.x, a.cz - mid.z) - Math.hypot(b.cx - mid.x, b.cz - mid.z))[0] : null;
  console.log('[spearable] near-miss target school (baseline):', JSON.stringify(targetSchool));

  if (probe && targetSchool && targetSchool.flee === 0) {
    const missDist = probe.radius + 0.5; // > radius (guaranteed geometric miss), << 1.1 m margin
    const r2 = await aimAndFire('yellowtail', missDist, 5);
    console.log('[spearable] near-miss aim/fire result (missDist', missDist.toFixed(2), 'm):', JSON.stringify(r2));
    await page.waitForTimeout(2000);
    const active2 = await page.evaluate(() => window.__spearDebug.isActive());
    const fight2 = await page.evaluate(() => window.__spearDebug.fightState());
    console.log('[spearable] after near-miss shot — isActive:', active2, 'fightState:', JSON.stringify(fight2), '(must be null — a clean miss)');
    await page.waitForTimeout(800);
    const after = await schoolFleeFor(targetSchool.id);
    console.log('[spearable] target school after near-miss:', JSON.stringify(after));
    await page.screenshot({ path: `${OUT}/05-near-miss-result.png` });
    if (fight2) {
      console.log('[spearable] INCONCLUSIVE: the shot actually hit (missDist too small for this fish) — Problem 1 is still proven, but this run did not exercise the miss branch.');
    } else if (after && after.flee > 0) {
      console.log('[spearable] PASS: baseline flee was 0, a clean near-miss alone raised it above 0 — the spook machinery fired for real.');
    } else {
      console.log('[spearable] FAIL: near-miss did not raise flee above 0.');
    }
    await page.evaluate(() => { window.__spearDebug.reset(); window.__spearDebug.forceReloadReady(); });

    // Negative control on a *different* fresh school (far enough from the one just spooked that it
    // should still be at baseline) — a wide-miss shot must not spook it.
    const schools1 = await page.evaluate(() => window.__fishDebug.activeSchools());
    const control = schools1.filter((s) => s.type === 'yellowtail' && s.id !== targetSchool.id && s.flee === 0)[0];
    if (control) {
      console.log('[spearable] negative-control school (baseline):', JSON.stringify(control));
      const yaw = 0;
      await page.evaluate(({ depth, x, z, yaw }) => window.__diverDebug.enterAt(depth, x, z, yaw), { depth: 1, x: control.cx, z: control.cz + 30, yaw });
      await page.waitForTimeout(600);
      await page.evaluate(() => { window.__spearDebug.setSyntheticTarget(null); window.__spearDebug.reset(); window.__spearDebug.forceReloadReady(); });
      const fired3 = await page.evaluate(() => window.__spearDebug.fire());
      console.log('[spearable] negative-control wide shot fired (30 m away, well past SPEAR_RANGE):', fired3);
      await page.waitForTimeout(1500);
      const controlAfter = await schoolFleeFor(control.id);
      console.log('[spearable] negative-control school after:', JSON.stringify(controlAfter));
      if (controlAfter && controlAfter.flee === 0) {
        console.log('[spearable] PASS: a shot nowhere near this school left its flee at 0 — the response is gated by real proximity, not "any shot fired".');
      } else {
        console.log('[spearable] NOTE: negative-control school shows flee > 0 — check for an unrelated nearby threat (e.g. the boat/diver itself).');
      }
    } else {
      console.log('[spearable] no clean second school available for the negative control — skipping.');
    }
  } else {
    console.log('[spearable] FAIL/NOTE: could not establish a clean (flee===0) baseline to test the near-miss response against.');
  }
} else {
  console.log('[spearable] FAIL/NOTE: no resident yellowtail found near REEF_ORIGIN.');
}

// --- Problem 3: density/variety — pool stats + screenshots ---------------------------------------
console.log('--- Problem 3: density/variety ---');
await page.evaluate(() => { window.__spearDebug.reset(); });
const poolStats = await page.evaluate(() => window.__fishDebug.poolStats());
const stats = await page.evaluate(() => window.__fishDebug.stats());
let totalTri = 0;
for (const p of poolStats) totalTri += p.triPerInstance * p.meshCount;
console.log('[spearable] fish stats (active schools/fish/species-draw-calls):', JSON.stringify(stats));
console.log('[spearable] active species pools:', poolStats.length, '(this is the real underwater draw-call contribution — one InstancedMesh per active species)');
for (const p of poolStats) console.log('   ', p.type, 'meshCount:', p.meshCount, 'inUse:', p.inUse, 'capacity:', p.capacity, 'triPerInstance:', p.triPerInstance);
console.log('[spearable] approx fish-system triangles this frame:', Math.round(totalTri));
await page.screenshot({ path: `${OUT}/06-density-reef.png` });

const deepHit = await approach('amberjack', REEF_ORIGIN.x, REEF_ORIGIN.z, 1800);
if (deepHit) {
  const deepSchools = await page.evaluate(() => window.__fishDebug.activeSchools());
  const types = [...new Set(deepSchools.map((s) => s.type))].sort();
  console.log('[spearable] species present near a DeepWall (amberjack) resident spot:', JSON.stringify(types));
  await page.screenshot({ path: `${OUT}/07-density-deepwall.png` });
} else {
  console.log('[spearable] NOTE: no amberjack resident found near REEF_ORIGIN to show the DeepWall band.');
}

console.log('[spearable] page errors:', errs);
await browser.close();
