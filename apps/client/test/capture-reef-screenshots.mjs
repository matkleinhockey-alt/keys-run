/**
 * Reef verification screenshots + real draw-call/triangle counts, per this task's "Verify"
 * section. Drives src/reef-harness.ts (not the shipped game — see that file's header for why:
 * there is no in-game underwater camera on this branch yet). Saves to test/screenshots/reef/.
 *
 * This sandboxed environment renders on a software/virtualized GPU (see other reports in this
 * repo), so waits are generous.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = (process.env.CLIENT_URL || 'http://localhost:5174') + '/reef-harness.html';
const OUT = path.join(HERE, 'screenshots', 'reef');
fs.mkdirSync(OUT, { recursive: true });

const WAYPOINTS = ['reef-crest', 'mid-slope', 'the-wall', 'sand-channel', 'seagrass-flat'];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__reefHarness), { timeout: 15000 });

  const report = {};
  let densest = { name: '', calls: 0, triangles: 0 };

  for (const name of WAYPOINTS) {
    await page.evaluate((n) => window.__reefHarness.goto(n), name);
    // Let a few frames render (chunk rebuild + draw) on this slow sandboxed GPU.
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const stats = await page.evaluate(() => window.__reefHarness.stats());
    const reefOnly = await page.evaluate(() => window.__reefHarness.statsReefOnly());
    const counts = await page.evaluate(() => window.__reefHarness.debugCounts());
    report[name] = { total: stats, reefOnly, counts };
    console.log(`[${name}] total=`, stats, 'reefOnly=', reefOnly);
    console.log(`  instancesBySpecies=`, counts.instancesBySpecies);
    if (reefOnly.triangles > densest.triangles) densest = { name, ...reefOnly };
  }

  fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify({ perWaypoint: report, densest }, null, 2));
  console.log('densest waypoint:', densest);
  console.log('page errors:', errs);
} finally {
  await browser.close();
}
console.log('done');
