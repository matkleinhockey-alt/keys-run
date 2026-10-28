/**
 * Screenshots of the rod under load, from test/rod-harness.html (see rod-harness.ts for why a
 * harness rather than the full game). Output: apps/client/test/screenshots/rod/.
 * Usage: CLIENT_URL=http://localhost:5199 node apps/client/test/capture-rod.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_URL } from './server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.CLIENT_URL || CLIENT_URL;
const OUT = path.join(HERE, 'screenshots', 'rod');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`${BASE}/test/rod-harness.html`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__rod, null, { timeout: 60000 });

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const rod = (fn, ...a) => page.evaluate(([f, args]) => window.__rod[f](...args), [fn, a]);

// first person: load ladder
await rod('hold', 0.0, 0.8); await shot('fp-1-unloaded');
await rod('hold', 0.3, 0.8, { slipping: false }); await shot('fp-2-light-0.30');
await rod('hold', 0.6, 0.8, { slipping: true, lineSpeed: 4 }); await shot('fp-3-working-0.60');
await rod('hold', 0.92, 0.8, { slipping: true, lineSpeed: 7, limit: 0.9 }); await shot('fp-4-near-limit-0.92');
// the same load, one frame after the hook pulls, and a beat later: recoil past straight, then ring
await rod('recoil', 0.92); await rod('release', 0.07); await shot('fp-5-recoil-whip-70ms');
await rod('step', 0.12); await shot('fp-6-ring-190ms');
await rod('step', 1.0); await shot('fp-7-settled');
// slack line, lying on the water
await rod('hold', 0.02, 0.8); await shot('fp-8-slack-line');
// third person (boat camera)
await rod('setFp', false);
await rod('hold', 0.0, 0.8); await shot('tp-1-unloaded');
await rod('hold', 0.5, 0.9, { slipping: true, lineSpeed: 5 }); await shot('tp-2-loaded-0.50');
await rod('hold', 0.92, 0.9, { slipping: true, lineSpeed: 7, limit: 0.9 }); await shot('tp-3-near-limit-0.92');
await rod('recoil', 0.92); await rod('release', 0.07); await shot('tp-4-recoil-whip');
// real physics, real-time-less: a yellowfin fight stepped with the actual stepFight
await rod('setFp', true);
const r1 = await rod('realFight', 6); await shot('fp-9-real-fight-6s'); console.log('real fight @6s', JSON.stringify(r1));
const r2 = await rod('realFight', 8); await shot('fp-10-real-fight-14s'); console.log('real fight @14s', JSON.stringify(r2));
console.log('page errors:', errs);
await browser.close();
