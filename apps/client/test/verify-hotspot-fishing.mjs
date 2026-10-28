/**
 * Playthrough check for hotspot-aware rod fishing: teleports beside a live bird/bait frenzy (and
 * a weedline, a rig, and a quiet control spot), casts for real, and records what the cast rolled.
 *
 *   cd apps/client && pnpm exec vite --port 5199    (NOT `pnpm --filter ... dev`: worktrees
 *   live inside the main repo and that walks up and serves the MAIN workspace)
 *   CLIENT_URL=http://localhost:5199 node test/verify-hotspot-fishing.mjs
 *
 * Bite wait is read as the rolled `F.biteT` the instant the bobber lands — the state machine
 * decrements exactly dt per sim step, so that number IS the wait in simulated seconds, and it
 * does not depend on this sandbox's ~3 fps render rate. The species is read after forcing
 * `biteT` under the 3.2 s pick threshold (the pick is independent of the timer), then the rod is
 * reset to idle; that shortcut is harness-only and does not touch the recorded wait.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_URL } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || CLIENT_URL;
const N = Number(process.env.SAMPLES || 6);
const OUT = path.join(HERE, 'screenshots', 'hotspot');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(BASE, { waitUntil: 'load' });
await page.waitForTimeout(800);
await page.click('.krAuthOffline').catch(() => {});
await page.click('#btnGo');
await page.waitForFunction(() => !!window.__fishDebug, null, { timeout: 120000 });

// Confirm we are serving THIS worktree: the module only exists here (an SPA fallback returns html).
const probe = await page.evaluate(async () => (await fetch('/src/game/fishing/spot.ts')).text());
if (!probe.includes('resolveCastSpot')) throw new Error('server is not serving the worktree (spot.ts missing)');

const stubs = await page.evaluateHandle(() => import('/src/stubs.ts'));
const fstate = await page.evaluateHandle(() => import('/src/game/fishing/state.ts'));

const sites = (kind) => page.evaluate(([s, k]) => {
  if (k === 'hot') return s.hotspots.map((h, i) => ({ i, x: h.x, z: h.z, zone: h.zone, active: h.active }));
  if (k === 'weed') return s.WEEDS.map((w, i) => ({ i, x: w.x, z: w.z }));
  return s.RIGS.filter((r) => r.g).map((r, i) => ({ i, x: r.x, z: r.z }));
}, [stubs, kind]);

async function castAt(label, x, z) {
  await page.evaluate(([x, z]) => {
    window.__fishDebug.teleport(x, z, 0);
  }, [x, z]);
  await page.evaluate((fs_) => { const F = fs_.F; F.state = 'idle'; F.key = null; F.hs = null; }, fstate);
  await page.waitForTimeout(1200);
  await page.keyboard.down('Space');
  await page.waitForTimeout(40); // minimum charge: shortest lob, 12 m
  await page.keyboard.up('Space');
  const landed = await page.waitForFunction((fs_) => fs_.F.state === 'waiting', fstate, { timeout: 120000, polling: 100 }).then(() => true, () => false);
  if (!landed) return { label, error: 'cast never landed' };
  const r = await page.evaluate((fs_) => {
    const F = fs_.F;
    const out = { zone: F.zone, hs: F.hs ? F.hs.fr : null, biteT: +F.biteT.toFixed(2), bob: { x: F.bob.x, z: F.bob.z } };
    F.biteT = 3.0; // harness-only: trigger the species pick without waiting out the timer
    return out;
  }, fstate);
  await page.waitForFunction((fs_) => !!fs_.F.key, fstate, { timeout: 60000, polling: 100 }).catch(() => {});
  const key = await page.evaluate((fs_) => fs_.F.key, fstate);
  await page.evaluate((fs_) => { const F = fs_.F; F.state = 'idle'; F.key = null; F.hs = null; }, fstate);
  return { label, ...r, key };
}

const rows = [];
async function activeHotspots() {
  const hs = (await sites('hot')).filter((h) => ['Offshore', 'Reef', 'Hawk Channel'].includes(h.zone));
  return { act: hs.filter((h) => h.active), quiet: hs.filter((h) => !h.active) };
}

// Screenshot of the call-out: park 900 m off a live frenzy and let the HUD update.
{
  await page.waitForFunction((s) => s.hotspots.some((h) => h.active), stubs, { timeout: 120000 });
  const { act } = await activeHotspots();
  const h = act[0];
  await page.evaluate(([x, z]) => window.__fishDebug.teleport(x, z + 900, 0), [h.x, h.z]);
  await page.waitForTimeout(6000);
  const callout = await page.evaluate(() => { const e = document.getElementById('hsCallout'); return e ? { text: e.textContent, display: e.style.display, rot: e.firstElementChild.style.transform } : null; });
  console.log('callout 900 m south of a live frenzy (boat h=0, so arrow should be ~0deg):', JSON.stringify(callout));
  await page.screenshot({ path: path.join(OUT, 'callout.png') });
}

for (let n = 0; n < N; n++) {
  const { act } = await activeHotspots();
  if (act.length) { const h = act[n % act.length]; rows.push({ kind: 'frenzy', ...(await castAt('frenzy#' + n, h.x, h.z)) }); }
  const { quiet } = await activeHotspots();
  if (quiet.length) { const h = quiet[n % quiet.length]; rows.push({ kind: 'control', ...(await castAt('control#' + n, h.x, h.z)) }); }
}
const weeds = await sites('weed');
for (let n = 0; n < 3 && weeds.length; n++) { const w = (await sites('weed'))[n]; rows.push({ kind: 'weedline', ...(await castAt('weed#' + n, w.x, w.z)) }); }
const rigs = await sites('rig');
for (let n = 0; n < 3 && rigs.length; n++) { const r = rigs[n]; rows.push({ kind: 'rig', ...(await castAt('rig#' + n, r.x + 30, r.z)) }); }

for (const r of rows) console.log(JSON.stringify(r));
const mean = (a) => a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2) : null;
for (const kind of ['frenzy', 'control', 'weedline', 'rig']) {
  const ok = rows.filter((r) => r.kind === kind && r.biteT !== undefined);
  console.log(kind, 'n=' + ok.length, 'mean bite wait (sim s)=' + mean(ok.map((r) => r.biteT)), 'hs set=' + ok.filter((r) => r.hs !== null).length, 'zones=' + [...new Set(ok.map((r) => r.zone))], 'species=' + ok.map((r) => r.key).join(','));
}
console.log('page errors:', errs.length ? errs.slice(0, 5) : 'none');
await browser.close();
