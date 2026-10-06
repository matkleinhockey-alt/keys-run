/**
 * World-life verification screenshots (task brief "Verify" section): crew on deck, the deck
 * party dancing, traffic on Hawk Channel, pelicans, Luigi mode, and sunset. Saved to
 * test/screenshots/life/.
 *
 * Uses the existing dev-only `window.__fishDebug.teleport(x,z,h)` hook (game/world.ts) to move
 * the boat near a traffic route without guessing world coordinates blind, and real keyboard input
 * (W / T / ArrowUp) to actually drive the boat up onto the trim/speed Luigi mode needs — there is
 * no debug backdoor for that, same as nothing in this game needs one for normal play.
 *
 * This sandbox renders on a software/virtualised GPU — generous waits, no fps claims.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL = process.env.CLIENT_URL || 'http://localhost:5191';
const OUT = path.join(HERE, 'screenshots', 'life');
fs.mkdirSync(OUT, { recursive: true });

async function readText(page, id) {
  return page.evaluate((id) => document.getElementById(id)?.textContent ?? null, id);
}
async function readDrawCalls(page) {
  const txt = await page.evaluate(() => document.getElementById('profilerHud')?.textContent ?? '');
  const m = txt.match(/draws?\D*(\d+)/i) ?? txt.match(/calls?\D*(\d+)/i);
  return { raw: txt, draws: m ? Number(m[1]) : null };
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(800);
await page.click('#btnGo'); // starts the AudioContext too (audio/index.ts init() on this gesture)
await page.waitForTimeout(1500);
await page.keyboard.press('KeyP'); // profiler HUD on
await page.waitForTimeout(300);

// 1. Crew on deck — captain + bikini crew member, default 3rd-person view, boat at rest.
{
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, '01-crew-on-deck.png') });
  console.log('crew on deck: draws', await readDrawCalls(page));
}

// 2. The deck party dancing — some of the 3-5 party members start in 'dance' mode immediately;
// wait a couple of beats so the pose blend settles into a clear move.
{
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, '02-party-dancing.png') });
  console.log('party dancing: draws', await readDrawCalls(page));
}

// 3. Traffic on Hawk Channel — teleport near x=0 (chainZ(0)=0), inside the hawk1/hawk2/hawk3
// chainRoute z-bands (450-1150) and close to reef's (1200-1320), so several boats relocate in.
{
  await page.evaluate(() => window.__fishDebug.teleport(0, 700, Math.PI));
  await page.waitForTimeout(2500); // traffic's relT (<=1.3s) + off-screen relocation settle
  await page.screenshot({ path: path.join(OUT, '03-traffic-hawk-channel.png') });
  console.log('traffic on Hawk Channel: draws', await readDrawCalls(page));
}

// 4. Pelicans — 2 of the 4 flocks spawn "near" (150-350m) the boat's starting position; return
// there and give them a moment to glide into frame.
{
  await page.evaluate(() => window.__fishDebug.teleport(-1150, 625, 0)); // near SPAWN_X/chainZ(SPAWN_X)+SPAWN_DZ
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, '04-pelicans.png') });
  console.log('pelicans: draws', await readDrawCalls(page));
}

// 5. Luigi mode — actually drive the boat: throttle up to speed, then trim all the way up.
// No debug backdoor for this (there's nothing resembling one for normal gameplay either).
{
  await page.evaluate(() => window.__fishDebug.teleport(0, 400, Math.PI)); // open water, pointed downrange
  await page.waitForTimeout(500);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(6000); // build up to cruise speed
  await page.keyboard.press('KeyT'); // trim mode (zeroes input.fwd for one instant — re-press W after)
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(5000); // trimV: 0.2 -> ~1 at a rate of 0.35/s
  console.log('pre-Luigi speed/trim:', await readText(page, 'gSpd'), await readText(page, 'gTrimV'));
  await page.waitForTimeout(1500); // LUIGI.k ramps in at 0.8/s once triggered
  await page.screenshot({ path: path.join(OUT, '05-luigi-mode.png') });
  console.log('Luigi mode: draws', await readDrawCalls(page));
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(500);
}

// 6. Sunset — #btnSun's click handler (this task's fix; it only had a keyboard binding before).
{
  await page.click('#btnSun');
  await page.waitForTimeout(3200); // TOD.k ramps over 3s
  await page.screenshot({ path: path.join(OUT, '06-sunset.png') });
  console.log('sunset: draws', await readDrawCalls(page));
}

console.log('console errors:', consoleErrors);
await browser.close();
console.log('done');
