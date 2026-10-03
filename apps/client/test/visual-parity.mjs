#!/usr/bin/env node
// @ts-nocheck
/**
 * Visual-parity check (docs/ARCHITECTURE.md Phase 0 acceptance criterion B): boots both the
 * legacy single-file build and the ported client, drives both with the same scripted input,
 * and screenshots four states from each: start screen, chase cam idle, chase cam at speed,
 * and the helm (first-person) view.
 *
 * This is NOT pixel-diffed — seeded RNG differences (vegetation/coral scatter) make that the
 * wrong test. It is meant to be looked at by a person (or an agent) and judged for structural
 * equivalence: same horizon, island shapes, water colour, HUD layout. Run with:
 *   node apps/client/test/visual-parity.mjs
 * (needs `pnpm --filter client exec playwright install chromium` once, and the legacy server +
 * client dev server either already running or this script will start them itself.)
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const OUT_DIR = path.join(HERE, 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

const LEGACY_PORT = 4411;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

function serveLegacy(port) {
  const html = fs.readFileSync(path.join(REPO_ROOT, 'legacy/index.html'));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function captureSequence(browser, url, label) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-01-start.png`) });

  // Leave the dock with the default (second) boat already selected, same on both builds.
  await page.click('#btnGo');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-02-chase-idle.png`) });

  // Accelerate + steer for a few seconds, chase camera.
  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(3500);
  await page.keyboard.up('KeyD');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-03-chase-speed.png`) });

  // Switch to the first-person helm view while still underway.
  await page.keyboard.press('Digit1');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-04-helm.png`) });

  await page.keyboard.up('KeyW');
  await page.close();
  return consoleErrors;
}

async function main() {
  const legacyServer = await serveLegacy(LEGACY_PORT);
  await waitForServer(`http://localhost:${LEGACY_PORT}`);
  await waitForServer(CLIENT_URL);

  const browser = await chromium.launch();
  try {
    const legacyErrors = await captureSequence(browser, `http://localhost:${LEGACY_PORT}`, 'legacy');
    const clientErrors = await captureSequence(browser, CLIENT_URL, 'client');
    console.log('legacy console errors:', legacyErrors);
    console.log('client console errors:', clientErrors);
  } finally {
    await browser.close();
    legacyServer.close();
  }
  console.log('Screenshots written to', OUT_DIR);
}

main().catch((e) => { console.error(e); process.exit(1); });
