/**
 * Bridge verification screenshots + real draw-call/triangle counts, per this task's "Verify"
 * section. Drives src/bridge-harness.ts (not the shipped game — see that file's header). Saves to
 * test/screenshots/bridge/.
 *
 * This sandboxed environment renders on a software/virtualized GPU, so waits are generous.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = (process.env.CLIENT_URL || 'http://localhost:5174') + '/bridge-harness.html';
const OUT = path.join(HERE, 'screenshots', 'bridge');
fs.mkdirSync(OUT, { recursive: true });

const WAYPOINTS = ['humped-span', 'piers-water-level', 'old-and-new', 'pigeon-key', 'old-bridge-arches'];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__bridgeHarness), { timeout: 20000 });

  const report = {};
  let worst = { name: '', calls: 0, triangles: 0 };

  for (const name of WAYPOINTS) {
    await page.evaluate((n) => window.__bridgeHarness.goto(n), name);
    // Let shadow cascades + water rebuild and a few frames render on this slow sandboxed GPU.
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const stats = await page.evaluate(() => window.__bridgeHarness.stats());
    report[name] = stats;
    console.log(`[${name}]`, stats);
    if (stats.calls > worst.calls) worst = { name, ...stats };
  }

  fs.writeFileSync(path.join(OUT, 'stats.json'), JSON.stringify({ perWaypoint: report, worst }, null, 2));
  console.log('highest draw-call waypoint:', worst);
  console.log('page errors:', errs);
} finally {
  await browser.close();
}
console.log('done');
