/**
 * Verifies the deployed leaderboard end to end, in a real browser, against production.
 *
 * Read-only: it opens the public board and reads what is rendered. It never logs in and never
 * submits a catch — this runs against the live database, and a test fish would land on the real
 * leaderboard next to real players.
 *
 * Usage: node apps/client/test/verify-prod-leaderboard.mjs [url]
 */
import { chromium } from 'playwright';

const URL = process.argv[2] || 'https://keys-run.vercel.app';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
const blocked = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('requestfailed', (r) => blocked.push(`${r.url()} — ${r.failure()?.errorText}`));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(1200);

const offline = page.locator('.krAuthOffline');
if (await offline.count()) { await offline.click(); await page.waitForTimeout(700); }
await page.click('#btnGo');
await page.waitForTimeout(2500);

// The board is public — no login needed to read it.
await page.click('text=Leaderboard');
await page.waitForTimeout(2500);

// ui/leaderboard/panel.ts's own markup: the panel is .krLbPanel, each entry an <li>
// (class `empty` when the board could not be read, which is the failure this is looking for).
const board = await page.evaluate(() => {
  const panel = document.querySelector('.krLbPanel');
  if (!panel) return null;
  return {
    open: !panel.classList.contains('hidden'),
    rows: Array.from(panel.querySelectorAll('li')).map((li) => ({
      empty: li.classList.contains('empty'),
      text: (li.textContent ?? '').replace(/\s+/g, ' ').trim(),
    })),
    sub: (panel.querySelector('.krLbSub')?.textContent ?? '').trim(),
  };
});
if (!board) throw new Error('leaderboard panel never mounted');
console.log('panel open:', board.open);
for (const r of board.rows) console.log(r.empty ? '  [EMPTY STATE] ' : '   ', r.text);
const unreachable = board.rows.some((r) => r.empty && /could not reach/i.test(r.text));
const real = board.rows.filter((r) => !r.empty).length;

await page.screenshot({ path: 'apps/client/test/screenshots/prod-leaderboard.png' });
await browser.close();

const apiFails = blocked.filter((b) => b.includes('/api/'));
console.log(apiFails.length ? `BLOCKED API REQUESTS:\n${apiFails.join('\n')}` : 'no blocked /api requests');
console.log(errors.length ? `PAGE ERRORS:\n${errors.join('\n')}` : 'no page errors');

if (unreachable) { console.error('FAIL: the client could not reach the leaderboard API.'); process.exit(1); }
if (real === 0) { console.error('FAIL: the board rendered no entries at all.'); process.exit(1); }
console.log(`OK: ${real} leaderboard entries rendered from ${URL}.`);
