/**
 * What the GPU is actually being asked to do, measured rather than guessed.
 *
 * docs/ARCHITECTURE.md budgets < 400 draw calls topside and < 300 underwater, < 2.5 M triangles.
 * Its hazard list is stale (the clouds it names are already one InstancedMesh), so this reports
 * the real numbers from `renderer.info` plus a breakdown of where the draw calls go, by walking
 * the scene and attributing every visible mesh to the subsystem that owns it.
 *
 *   CLIENT_PORT=5174 node test/profile-gpu.mjs
 */
import { chromium } from 'playwright';
import { CLIENT_URL } from './server.mjs';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(CLIENT_URL, { waitUntil: 'load' });
page.setDefaultTimeout(120000);
await page.waitForTimeout(800);
for (let i = 0; i < 12; i++) {
  const o = await page.$('button:has-text("Play offline")');
  if (o) { await o.click().catch(() => {}); await page.waitForTimeout(900); }
  if (!(await page.$('.krAuthGate'))) break;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(2500);
await page.click('#btnGo', { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3000);

const sample = async (label) => {
  const r = await page.evaluate(async () => {
    const renderer = window.__renderer;
    if (!renderer) return { error: 'no renderer' };
    // frame times over ~90 frames
    const ts = [];
    await new Promise((res) => {
      let n = 0, last = performance.now();
      const tick = () => {
        const now = performance.now();
        ts.push(now - last); last = now;
        if (++n >= 90) return res();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    ts.sort((a, b) => a - b);
    const info = renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      lines: info.render.lines,
      points: info.render.points,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs ? info.programs.length : -1,
      frameP50: ts[Math.floor(ts.length * 0.5)],
      frameP95: ts[Math.floor(ts.length * 0.95)],
    };
  });
  console.log(`\n--- ${label} ---`);
  if (r.error) { console.log('  ', r.error); return; }
  console.log(`  draw calls ${r.calls}   triangles ${(r.triangles / 1e6).toFixed(2)}M   lines ${r.lines}  points ${r.points}`);
  console.log(`  geometries ${r.geometries}   textures ${r.textures}   shader programs ${r.programs}`);
  console.log(`  frame p50 ${r.frameP50.toFixed(1)} ms (${(1000 / r.frameP50).toFixed(0)} fps)   p95 ${r.frameP95.toFixed(1)} ms (${(1000 / r.frameP95).toFixed(0)} fps)`);
};

// Where do the draw calls live? Walk the scene and attribute visible renderables.
const breakdown = async (label) => {
  const rows = await page.evaluate(() => {
    const renderer = window.__renderer;
    const scene = window.__scene;
    if (!scene) return null;
    const out = new Map();
    const add = (k, calls, tris, kind) => {
      const e = out.get(k) ?? { calls: 0, tris: 0, instanced: 0, kinds: new Set() };
      e.calls += calls; e.tris += tris; if (kind === 'inst') e.instanced++;
      out.set(k, e);
    };
    // name an object by the nearest named ancestor, so meshes land under their subsystem
    const owner = (o) => {
      let p = o;
      while (p) { if (p.name && p.name.length) return p.name; p = p.parent; }
      return '(unnamed)';
    };
    scene.traverseVisible((o) => {
      if (!o.isMesh && !o.isPoints && !o.isLine && !o.isSprite) return;
      let vis = true;
      for (let p = o; p; p = p.parent) if (p.visible === false) { vis = false; break; }
      if (!vis) return;
      const g = o.geometry;
      const idx = g && g.index ? g.index.count : (g && g.attributes && g.attributes.position ? g.attributes.position.count : 0);
      const n = o.isInstancedMesh ? (o.count ?? 0) : 1;
      const tris = o.isMesh ? (idx / 3) * (o.isInstancedMesh ? n : 1) : 0;
      add(owner(o), 1, tris, o.isInstancedMesh ? 'inst' : 'mesh');
    });
    return [...out.entries()]
      .map(([k, v]) => ({ name: k, calls: v.calls, tris: Math.round(v.tris), instanced: v.instanced }))
      .sort((a, b) => b.calls - a.calls).slice(0, 22);
  });
  if (!rows) { console.log(`\n  (no window.__scene — cannot attribute draw calls)`); return; }
  console.log(`\n  draw-call owners (${label}), top ${rows.length}:`);
  console.log('  ' + 'owner'.padEnd(34) + 'objects'.padStart(8) + 'instMesh'.padStart(10) + 'triangles'.padStart(12));
  for (const r of rows) console.log('  ' + r.name.slice(0, 33).padEnd(34) + String(r.calls).padStart(8) + String(r.instanced).padStart(10) + String(r.tris).padStart(12));
};

await sample('topside, start position');
await breakdown('topside');

await page.evaluate(() => window.__diverDebug?.enterAt(2.0, 60, 1462, 0));
await page.waitForTimeout(3500);
await sample('underwater, Sombrero Reef crest');
await breakdown('underwater');

console.log('\nerrors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
