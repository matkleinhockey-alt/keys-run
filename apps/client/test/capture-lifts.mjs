/**
 * Boats on the estate lifts: the right hull, the right way round, on a frame that fits it.
 *
 * Framing: each estate has a house and, straight out from it, the lift. Standing seaward of the
 * lift on that same line and looking back at the shore puts the dock, the lift and the boat in
 * one shot — a fixed x/z offset does not, because the dock can run out in any direction.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { CLIENT_URL } from './server.mjs';
const OUT = 'test/screenshots/lifts'; fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.setDefaultTimeout(120000);
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
p.on('crash', () => errs.push('PAGE CRASHED'));
await p.goto(CLIENT_URL, { waitUntil: 'load' }); await p.waitForTimeout(800);
const off = await p.$('button:has-text("Play offline")'); if (off) { await off.click(); await p.waitForTimeout(900); }
// Default quality on purpose. Cycling to High with KeyG schedules a navigation, and the #btnGo
// click then blocks on it until the timeout — and geometry is what this shot is checking, not
// shading.
await p.waitForTimeout(3500);
await p.click('#btnGo'); await p.waitForTimeout(2500);

const sites = await p.evaluate(() => window.__fishDebug.waterfrontSites());
const lifts = await p.evaluate(() => window.__fishDebug.waterfrontLifts());
const spread = {};
for (const l of lifts) spread[l.boat] = (spread[l.boat] ?? 0) + 1;
console.log('lifts:', lifts.length, '| built at boot:', lifts.filter((l) => l.built).length);
console.log('fleet spread:', JSON.stringify(spread));

// The deepest lifts: the shallow ones leave the camera boat aground in a foot of water with the
// dock behind a shoal, which photographs as nothing at all.
const order = sites
  .map((S, i) => ({ i, S, d: (lifts.find((l) => Math.hypot(l.x - S.lx, l.z - S.lz) < 1) ?? { depth: 0 }).depth }))
  .sort((a, b) => b.d - a.d);
for (const { i, S } of order.slice(0, 3)) {
  const ox = S.lx - S.x, oz = S.lz - S.z, ol = Math.hypot(ox, oz) || 1;
  const vx = S.lx + ox / ol * 78, vz = S.lz + oz / ol * 78;
  // To look from V at T: atan2(V.x - T.x, V.z - T.z).
  await p.evaluate(({ vx, vz, h }) => window.__fishDebug.teleport(vx, vz, h),
    { vx, vz, h: Math.atan2(vx - S.lx, vz - S.lz) });
  await p.waitForTimeout(15000).catch(() => {});
  const bs = await p.evaluate(() => window.__fishDebug.boatState());
  const vd = await p.evaluate(({ x, z }) => window.__fishDebug.waterColumnAt(x, z), { x: bs.x, z: bs.z });
  console.log(`  boat ${bs.x.toFixed(0)},${bs.z.toFixed(0)} in ${JSON.stringify(vd).slice(0, 70)} | house ${S.x.toFixed(0)},${S.z.toFixed(0)} -> lift ${S.lx.toFixed(0)},${S.lz.toFixed(0)}`);
  const me = (await p.evaluate(() => window.__fishDebug.waterfrontLifts()))
    .reduce((a, q) => (Math.hypot(q.x - S.lx, q.z - S.lz) < Math.hypot(a.x - S.lx, a.z - S.lz) ? q : a));
  console.log(`site ${i}: ${me.boat} ${me.len}x${me.beam}m  lift depth ${me.depth}m  built=${me.built} visible=${me.visible}`);
  await p.screenshot({ path: `${OUT}/lift-${i}.png` });
}
console.log('errs', errs.slice(0, 3));
await b.close();
