/**
 * End-to-end verification for feat/leaderboard-writes: register -> log in -> land a catch in a
 * real browser -> re-read /leaderboard/overall and /leaderboard/species on apps/api and confirm a
 * non-empty row -> screenshot the leaderboard panel showing it.
 *
 * Uses window.__catchPortraitDebug.land(key, weight) (game/catch/catch-flow.ts's verification
 * hook, same one capture-catch-portrait.mjs uses) to land a fish instantly rather than playing out
 * a real cast->fight->land — that hook still runs the real landFish code path, including the real
 * submitCatch() POST to apps/api, which is the thing this script is actually verifying. Skipping
 * only the multi-minute fishing minigame, not the catch-write wiring.
 *
 * Usage: node test/capture-leaderboard-writes.mjs
 *   Requires apps/api running locally (see CLIENT_URL/API_URL below for the ports used) and the
 *   client dev server up against it.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || 'http://localhost:5173';
const API = process.env.API_URL || 'http://localhost:8090';
const OUT = path.join(HERE, 'screenshots', 'leaderboard');
fs.mkdirSync(OUT, { recursive: true });

const unique = Date.now();
const EMAIL = `lb-verify-${unique}@keysrun.test`;
const PASSWORD = 'leaderboard-verify-pw-1';
const DISPLAY_NAME = `LBVerify${unique}`.slice(0, 20);
// wahoo (min 15 / max 90 lb) rather than tarpon: apps/api/src/db/seed.ts's dev fixtures already
// seed tarpon/mahi/bluefin/bonefish/permit records into the local dev database this script talks
// to, so a fresh species avoids a false "species record" failure when our weight is honestly
// lower than an existing seeded record (a real, correct outcome of the "only upsert if it beats
// the current best" logic, not a bug — but it would make this script's species-tab assertion
// about *our* row depend on incidental seed data).
const SPECIES_KEY = 'wahoo';
const WEIGHT_LB = 52.3; // comfortably inside [15, 90] -> must NOT be flagged suspicious

let failed = false;
function check(label, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'} — ${label}`);
  if (!cond) failed = true;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });

console.log(`registering ${EMAIL} / ${DISPLAY_NAME}`);
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForSelector('.krAuthGate', { timeout: 10000 });

// Switch to the Register tab, fill the form, submit. gate.ts's submit() chains
// register -> login -> me -> saveSession -> finish({mode:'online', ...}), so a successful
// submit removes the overlay entirely with no further click needed.
await page.click('[data-tab="register"]');
await page.fill('input[name="email"]', EMAIL);
await page.fill('input[name="displayName"]', DISPLAY_NAME);
await page.fill('input[name="password"]', PASSWORD);
await page.click('.krAuthSubmit');

await page.waitForSelector('.krAuthGate', { state: 'detached', timeout: 10000 });
console.log('gate dismissed — registered and logged in');

// Confirm ui/auth/session.ts actually holds a session now (sessionStorage), i.e. we are the
// 'online' gate path, not 'offline'.
const session = await page.evaluate(() => {
  try { return JSON.parse(sessionStorage.getItem('keysrun.session.v1') || 'null'); } catch { return null; }
});
check('client holds a saved session after login', !!session?.token && !!session?.userId);

// Start screen -> "Leave the dock", same as capture-catch-portrait.mjs.
await page.click('#btnGo');
await page.waitForTimeout(500);

const hasHook = await page.evaluate(() => typeof window.__catchPortraitDebug?.land === 'function');
check('__catchPortraitDebug.land hook is present', hasHook);
if (!hasHook) {
  console.error('build out of date or hook missing — aborting');
  await browser.close();
  process.exit(1);
}

console.log(`landing ${WEIGHT_LB} lb ${SPECIES_KEY} via the real landFish() path (-> submitCatch -> POST ${API}/catches)`);
await page.evaluate(({ key, weight }) => window.__catchPortraitDebug.land(key, weight), { key: SPECIES_KEY, weight: WEIGHT_LB });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/01-catch-card.png` });

// Give the fire-and-forget POST time to land before we read it back.
await page.waitForTimeout(1500);

// Open the leaderboard panel and look at both tabs.
await page.click('.krLbOpenBtn');
await page.waitForSelector('.krLbPanel:not(.hidden)');
await page.waitForTimeout(400); // renderBig()'s own fetches (overall + maybe own-records)
await page.screenshot({ path: `${OUT}/02-leaderboard-overall.png` });

const bigText = await page.locator('.krLbCard').innerText();
check('overall tab shows a "You" row', /You/.test(bigText));
check('overall tab shows the landed weight', bigText.includes(String(WEIGHT_LB)));
console.log('--- overall tab text ---\n' + bigText + '\n---');

await page.click('[data-tab="sp"]');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/03-leaderboard-species.png` });
const spText = await page.locator('.krLbCard').innerText();
check('species tab shows "You" against Wahoo', spText.includes('Wahoo') && /You/.test(spText));
console.log('--- species tab text ---\n' + spText + '\n---');

await browser.close();

// Independently re-read apps/api directly (not through the page) to confirm the write really
// landed server-side, per the task's "re-read /leaderboard/overall and /leaderboard/species and
// show a non-empty row" requirement.
const overallRes = await fetch(`${API}/leaderboard/overall`);
const overall = await overallRes.json();
const mine = overall.rows.find((r) => r.displayName === DISPLAY_NAME);
check('GET /leaderboard/overall (fresh fetch) contains our row', !!mine);
if (mine) check('row has the right species/weight', mine.speciesKey === SPECIES_KEY && mine.weightLb === WEIGHT_LB);
console.log('overall rows count:', overall.rows.length, 'our row:', mine);

const speciesRes = await fetch(`${API}/leaderboard/species`);
const species = await speciesRes.json();
const tarponRow = species.rows.find((r) => r.speciesKey === SPECIES_KEY);
check('GET /leaderboard/species tarpon row top is us', tarponRow?.top?.displayName === DISPLAY_NAME);
console.log('tarpon row:', tarponRow);

check('no page errors during the run', pageErrors.length === 0);
if (pageErrors.length) console.log('page errors:', pageErrors);

console.log(failed ? '\n*** ONE OR MORE CHECKS FAILED ***' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
