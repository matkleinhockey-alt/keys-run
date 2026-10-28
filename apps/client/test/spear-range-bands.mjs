/**
 * How far can you actually shoot a fish? Hit rate BY DISTANCE BAND, in the real game, down the
 * real aim/assist/fire path — which is the measurement the overall hit-rate harness
 * (verify-spear-hitrate.mjs) cannot make, because one aggregate number hides a gun that works
 * beautifully at 6 m and not at all at 14.
 *
 * It also reports what the gun can SEE and how far away it is, because "the fish have to come
 * closer before you can shoot" is two claims — the gun's reach and where the fish sit — and they
 * want separating before anything is tuned.
 *
 * Usage:  CLIENT_URL=http://localhost:5441 node test/spear-range-bands.mjs
 *
 * Samples are small (14 per band) and this sandbox runs at ~3 fps, so treat a single run as an
 * indication and re-run before concluding anything from a 2-shot difference. The 10% -> 36%
 * change at 9-13 m that the lead fix produced is well outside that noise; a 0 -> 1 is not.
 *
 * Aim and fire happen in ONE page evaluate with nothing between them. Aiming and then sleeping
 * lets the fish move most of a metre before the shot leaves, and that is the harness missing
 * rather than the gun.
 */
import { chromium } from 'playwright';
import { CLIENT_URL } from './server.mjs';
const URL = CLIENT_URL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1000, height: 600 } });
p.setDefaultTimeout(180000);
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(URL, { waitUntil: 'load' });
await sleep(900);
const off = await p.$('.krAuthOffline'); if (off) await off.click();
await sleep(500);
await p.click('#btnGo'); await sleep(3500);
await p.evaluate(() => window.__fishDebug.teleport(300, 900, 0));
await sleep(2000);
await p.keyboard.press('KeyJ');       // overboard
await sleep(12000);
console.log('diver mode:', await p.evaluate(() => window.__spearDebug.diverMode()));

// 1. what is out there, and how far
const sample = async () => p.evaluate(() => {
  const t = window.__spearDebug.targets();
  return { n: t.length, dists: t.map((x) => x.dist).sort((a, b) => a - b), keys: [...new Set(t.map((x) => x.key))] };
});
const rows = [];
for (let i = 0; i < 8; i++) { rows.push(await sample()); await sleep(2500); }
const nearest = rows.map((r) => r.dists[0]).filter((d) => d != null);
const counts = rows.map((r) => r.n);
console.log('targets visible to the gun, per sample:', JSON.stringify(counts));
console.log('nearest fish distance per sample (m):', JSON.stringify(nearest));
console.log('all distances, last sample (m):', JSON.stringify(rows.at(-1).dists.slice(0, 25)));
console.log('species in range:', JSON.stringify(rows.at(-1).keys));

// 2. hit rate by distance band, aiming with the real assist path
const bands = [[2, 5], [5, 9], [9, 13], [13, 18], [18, 24]];
const res = {};
for (const [lo, hi] of bands) {
  let fired = 0, hit = 0; const radii = [];
  for (let k = 0; k < 14; k++) {
    const tgt = await p.evaluate(({ lo, hi }) => {
      const t = window.__spearDebug.targets().filter((x) => x.dist >= lo && x.dist < hi);
      if (!t.length) return null;
      const c = t[0];
      window.__spearDebug.setLook(c.x, c.y, c.z);
      return { id: c.id, dist: c.dist, key: c.key };
    }, { lo, hi });
    if (!tgt) { await sleep(900); continue; }
    // Reload FIRST, then re-aim and fire in ONE evaluate with nothing between them. Aiming and
    // then sleeping lets the fish move before the shot leaves, which at this sandbox's ~3 fps is
    // most of a metre — that is the harness missing, not the gun.
    await p.evaluate(() => { window.__spearDebug.forceReloadReady(); });
    await sleep(400);
    const shotInfo = await p.evaluate((id) => {
      const c = window.__spearDebug.targets().find((x) => x.id === id);
      if (!c) return null;
      window.__spearDebug.setLook(c.x, c.y, c.z);
      const ok = window.__spearDebug.fire();
      return ok ? { dist: c.dist, radius: c.radius, key: c.key } : null;
    }, tgt.id);
    if (!shotInfo) { await sleep(600); continue; }
    radii.push(+shotInfo.radius.toFixed(2));
    fired++;
    let got = false;
    for (let w = 0; w < 16; w++) {
      await sleep(230);
      const s = await p.evaluate(() => ({ a: window.__spearDebug.isActive(), f: !!window.__spearDebug.fightState() }));
      if (s.f) { got = true; break; }
      if (!s.a) break;
    }
    if (got) { hit++; await p.evaluate(() => window.__spearDebug.reset()); await sleep(700); }
  }
  res[`${lo}-${hi} m`] = { fired, hit, rate: fired ? +(hit / fired).toFixed(2) : null, capsuleR: radii.length ? +(radii.reduce((a, c) => a + c, 0) / radii.length).toFixed(2) : null };
  console.log(`${lo}-${hi} m:`, JSON.stringify(res[`${lo}-${hi} m`]));
}
console.log('SUMMARY', JSON.stringify(res));
console.log('page errors:', errs.length ? errs.slice(0, 3) : 'none');
await b.close();
