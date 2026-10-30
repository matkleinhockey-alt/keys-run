/**
 * Verification frames for game/tournament/** (offline): the opening titles (title card, a boat's
 * name card, "lines in"), the live HUD, keeping all five through the real catch card, the drop-off
 * in Boot Key Harbor, and the ceremony's three shots. Saved to test/screenshots/tournament/.
 *
 * This sandbox renders a frame or two a second, so each moment is held with the link's debug clock
 * pin (`window.__tourneyClock`) while it renders, then released. The script
 * lands the five species with __catchPortraitDebug and presses the card's real Keep button (the
 * path a real catch takes), and teleports the boat into the harbour with __fishDebug.teleport.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5174';
const OUT = path.join(HERE, 'screenshots', 'tournament');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.setDefaultTimeout(300000);
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('ERR_CONNECTION_REFUSED')) errs.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(900);
const offline = page.locator('.krAuthOffline');
if (await offline.count()) { await offline.click(); await page.waitForTimeout(600); }
await page.click('#btnGo');
await page.waitForTimeout(2500);

const dbg = () => page.evaluate(() => {
  const d = window.__tourneyDebug.debug();
  const t = d.tourney;
  return t && { s: d.now - (t.t0 - 15), species: t.species, winner: t.winner, entries: t.entries, fleet: d.fleet, spot: d.ceremonySpot };
});
const waitUntil = async (pred, label, ms = 120000) => {
  const t0 = Date.now();
  for (;;) { const s = await dbg(); if (s && pred(s)) return s; if (Date.now() - t0 > ms) throw new Error(`timeout: ${label} ${JSON.stringify(s)}`); await page.waitForTimeout(100); }
};

await page.click('#btnTourney');
const first = await dbg();
console.log('species:', first.species.join(', '), '| ceremony spot:', JSON.stringify(first.spot));
/** Holds the tournament clock at `s` seconds into the countdown long enough to render, then shoots. */
const hold = async (sec, name, base) => {
  await page.evaluate((v) => { window.__tourneyClock = v; }, base + sec);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/${name}.png` });
};
const base = await page.evaluate(() => { const d = window.__tourneyDebug.debug(); return d.tourney.t0 - 15; });
for (const [at, name] of [[1.8, '01-title'], [5.0, '02-boat-a'], [6.9, '03-boat-b'], [12.6, '04-boat-you'], [14.6, '05-lines-in']]) await hold(at, name, base);
// Released: then let the fleet get going (real clock again, from the gun).
await page.evaluate((v) => { window.__tourneyClock = v; }, base + 15);
await page.evaluate(() => { const d = window.__tourneyDebug.debug(); d.tourney.t0 = performance.now() / 1000; window.__tourneyClock = undefined; });
await waitUntil((s) => s.s >= 15 + 25, 'heading out');
await page.screenshot({ path: `${OUT}/06-live-hud.png` });
console.log('fleet under way:', JSON.stringify((await dbg()).fleet.map((b) => ({ s: Math.round(b.s), v: +b.speed.toFixed(1) }))));

// Keep one of each through the real card.
for (const key of first.species) {
  await page.evaluate((k) => window.__catchPortraitDebug.land(k, 14.2), key);
  await page.waitForTimeout(900);
  await page.click('#btnKeep');
  await page.waitForTimeout(500);
}
const caught = await dbg();
console.log('my mask after keeping five:', caught.entries.find((e) => e.id === 'me')?.mask);
await page.screenshot({ path: `${OUT}/07-all-five.png` });

// Into the harbour, stopped: the drop-off.
// HARBOUR (sim/tournament.ts): MARINAS[0]'s approach point.
await page.evaluate(() => window.__fishDebug.teleport(-900, 150.67, 0));
const won = await waitUntil((s) => !!s.winner, 'winner', 20000);
console.log('winner:', JSON.stringify(won.winner));
const winBase = await page.evaluate(() => { const d = window.__tourneyDebug.debug(); return d.tourney.t0 + d.tourney.winner.at; });
for (const [dt, name] of [[1.2, '08-ceremony-wide'], [5.0, '09-ceremony-trophy'], [8.6, '10-ceremony-fish'], [12, '11-after']]) await hold(dt, name, winBase);
await page.evaluate(() => { window.__tourneyClock = undefined; });
console.log('trophies:', await page.evaluate(() => window.__tourneyDebug.trophies()));
console.log('errors:', errs);
await browser.close();
