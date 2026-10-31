/**
 * Where the draw calls go, counted in one pass.
 *
 * `renderer.info.render.calls` gives the total and nothing else. Hiding one group at a time and
 * re-rendering does attribute it, but at software-WebGL frame rates that is ten minutes of
 * renders and the scene drifts underneath the measurement. This instead rebuilds the view
 * frustum from `window.__camera` and applies the same test three.js applies inside render(), so
 * one traversal says what survives culling and who owns it.
 *
 *   CLIENT_PORT=5174 node test/profile-gpu-owners.mjs [--dive]
 */
import { chromium } from 'playwright';
import { CLIENT_URL } from './server.mjs';

const dive = process.argv.includes('--dive');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
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
if (dive) { await page.evaluate(() => window.__diverDebug?.enterAt(2.0, 60, 1462, 0)); await page.waitForTimeout(3500); }

const out = await page.evaluate(() => {
  const scene = window.__scene, camera = window.__camera, renderer = window.__renderer;
  if (!scene || !camera) return { error: 'missing __scene/__camera' };
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);

  // Frustum planes straight off the matrices, so this needs no THREE namespace on window.
  // three.js stores Matrix4 column-major: row r of the matrix is te[r], te[4+r], te[8+r], te[12+r].
  const mul = (a, b) => { // a * b, both column-major
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  };
  const te = mul(camera.projectionMatrix.elements, camera.matrixWorldInverse.elements);
  const row = (r) => [te[r], te[4 + r], te[8 + r], te[12 + r]];
  const [r0, r1, r2, r3] = [row(0), row(1), row(2), row(3)];
  const combine = (a, b, sign) => a.map((v, i) => v + sign * b[i]);
  const planes = [
    combine(r3, r0, 1), combine(r3, r0, -1),
    combine(r3, r1, 1), combine(r3, r1, -1),
    combine(r3, r2, 1), combine(r3, r2, -1),
  ].map((pl) => {
    const l = Math.hypot(pl[0], pl[1], pl[2]) || 1;
    return [pl[0] / l, pl[1] / l, pl[2] / l, pl[3] / l];
  });
  const visibleSphere = (e, c, radius) => {
    const x = e[0] * c.x + e[4] * c.y + e[8] * c.z + e[12];
    const y = e[1] * c.x + e[5] * c.y + e[9] * c.z + e[13];
    const z = e[2] * c.x + e[6] * c.y + e[10] * c.z + e[14];
    const sx = Math.hypot(e[0], e[1], e[2]), sy = Math.hypot(e[4], e[5], e[6]), sz = Math.hypot(e[8], e[9], e[10]);
    const r = radius * Math.max(sx, sy, sz);
    for (const pl of planes) if (pl[0] * x + pl[1] * y + pl[2] * z + pl[3] <= -r) return false;
    return true;
  };

  // the top-level scene child an object belongs to — the subsystem that owns it
  const top = new Map();
  // Key each top-level child separately. Merging every unnamed Group under one label made the
  // first run report a single 995-draw-call owner that did not exist — it was the sum of many.
  scene.children.forEach((c, i) => {
    let meshes = 0;
    c.traverse((o) => { if (o.isMesh) meshes++; });
    const label = c.name || `#${i} (${c.type}, ${meshes} meshes)`;
    c.traverse((o) => top.set(o, label));
  });

  const rows = new Map();
  const bump = (k, f) => {
    const e = rows.get(k) ?? { drawn: 0, culled: 0, tris: 0, inst: 0 };
    f(e); rows.set(k, e);
  };
  scene.traverse((o) => {
    if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
    let vis = true;
    for (let p = o; p; p = p.parent) if (!p.visible) { vis = false; break; }
    const owner = top.get(o) ?? '(detached)';
    if (!vis) { bump(owner, (e) => e.culled++); return; }
    let drawn = true;
    if (o.frustumCulled && o.geometry) {
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const bs = o.geometry.boundingSphere;
      drawn = !bs || visibleSphere(o.matrixWorld.elements, bs.center, bs.radius);
    }
    if (!drawn) { bump(owner, (e) => e.culled++); return; }
    const g = o.geometry;
    const verts = g ? (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) : 0;
    const n = o.isInstancedMesh ? (o.count ?? 0) : 1;
    bump(owner, (e) => { e.drawn++; e.tris += (verts / 3) * n; if (o.isInstancedMesh) e.inst += n; });
  });
  return {
    actual: renderer.info.render.calls,
    rows: [...rows.entries()].map(([name, v]) => ({ name, ...v, tris: Math.round(v.tris) }))
      .sort((a, b) => b.drawn - a.drawn),
  };
});

if (out.error) { console.log(out.error); } else {
  const sum = out.rows.reduce((a, r) => a + r.drawn, 0);
  console.log(`\n${dive ? 'UNDERWATER' : 'TOPSIDE'}  renderer says ${out.actual} draw calls; this pass attributes ${sum}\n`);
  console.log('  ' + 'owner'.padEnd(42) + 'drawn'.padStart(7) + 'culled'.padStart(8) + 'instances'.padStart(11) + 'triangles'.padStart(11));
  for (const r of out.rows.slice(0, 16)) {
    if (r.drawn === 0 && r.culled === 0) continue;
    console.log('  ' + r.name.slice(0, 40).padEnd(42) + String(r.drawn).padStart(7) + String(r.culled).padStart(8) + String(r.inst).padStart(11) + String(r.tris).padStart(11));
  }
}
await browser.close();
