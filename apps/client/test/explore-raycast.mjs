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

await page.screenshot({ path: '/tmp/explore-raycast-before.png' });

const diag = await page.evaluate(() => {
  const THREE = window.__THREE;
  const scene = window.__debugScene;
  let cam = null;
  scene.traverse((o) => { if (o.isCamera) cam = o; });
  const raycaster = new THREE.Raycaster();
  raycaster.near = cam.near;
  raycaster.far = cam.far;
  // Straight down the camera's forward direction (screen center).
  raycaster.setFromCamera({ x: 0, y: 0 }, cam);
  const hits = raycaster.intersectObjects(scene.children, true);
  return hits.slice(0, 10).map((h) => ({
    name: h.object.name || h.object.type,
    isInstanced: !!h.object.isInstancedMesh,
    instanceId: h.instanceId,
    color: h.object.material && h.object.material.color ? h.object.material.color.getHexString() : (Array.isArray(h.object.material) ? h.object.material.map(m => m.color && m.color.getHexString()) : undefined),
    geomType: h.object.geometry && h.object.geometry.type,
    distance: h.distance,
    point: h.point.toArray(),
    parentChain: (() => { const chain = []; let p = h.object.parent; while (p) { chain.push(p.name || p.type); p = p.parent; } return chain; })(),
    visible: h.object.visible,
  }));
});

console.log(JSON.stringify(diag, null, 2));
await browser.close();
