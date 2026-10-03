import { chromium } from 'playwright';

const URL = process.env.CLIENT_URL || 'http://localhost:5174';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));

await page.goto(URL, { waitUntil: 'load' });
await page.waitForTimeout(500);
await page.click('#btnGo');
await page.waitForTimeout(500);

const chainZ = (x) => 0.000012 * x * x;
const DIVE_X = 250, DIVE_DZ = 1550;
const DIVE_Z = chainZ(DIVE_X) + DIVE_DZ;
await page.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: DIVE_X, z: DIVE_Z });
await page.waitForTimeout(500);
await page.keyboard.press('KeyJ');
await page.waitForTimeout(500);

await page.keyboard.down('ShiftLeft');
await page.keyboard.down('KeyC');
await page.waitForTimeout(15000);
await page.keyboard.up('KeyC');
await page.keyboard.up('ShiftLeft');

const diag = await page.evaluate(() => {
  const scene = window.__debugScene;
  const cam = (() => {
    // find the camera: it's the object with isCamera true somewhere in the scene graph
    let found = null;
    scene.traverse((o) => { if (o.isCamera) found = o; });
    return found;
  })();
  const camPos = cam ? cam.position.toArray() : null;
  const near = [];
  scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    if (!o.geometry || !o.geometry.boundingSphere) {
      try { o.geometry.computeBoundingSphere(); } catch (e) { /* ignore */ }
    }
    const bs = o.geometry && o.geometry.boundingSphere;
    if (!bs) return;
    const worldPos = o.getWorldPosition(new (o.position.constructor)());
    const d = camPos ? Math.hypot(worldPos.x - camPos[0], worldPos.y - camPos[1], worldPos.z - camPos[2]) : -1;
    if (d >= 0 && d < 40) {
      near.push({
        name: o.name || o.type,
        isInstanced: !!o.isInstancedMesh,
        count: o.isInstancedMesh ? o.count : undefined,
        color: o.material && o.material.color ? o.material.color.getHexString() : undefined,
        geomType: o.geometry.type,
        dist: d,
        worldPos: worldPos.toArray(),
        parentChain: (() => { const chain = []; let p = o.parent; while (p) { chain.push(p.name || p.type); p = p.parent; } return chain; })(),
      });
    }
  });
  near.sort((a, b) => a.dist - b.dist);
  return { camPos, near: near.slice(0, 20) };
});

console.log(JSON.stringify(diag, null, 2));
await page.screenshot({ path: '/tmp/explore-diag.png' });
await browser.close();
