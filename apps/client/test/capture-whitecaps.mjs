/**
 * Whitecaps by sea state: none in a calm, scattered in a chop, streaked at Haulover.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { CLIENT_URL } from './server.mjs';
const OUT = 'test/screenshots/whitecaps'; fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.setDefaultTimeout(120000);
const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
await p.goto(CLIENT_URL, { waitUntil: 'load' }); await p.waitForTimeout(800);
for (let i = 0; i < 12; i++) {
  const o = await p.$('button:has-text("Play offline")');
  if (o) { await o.click().catch(() => {}); await p.waitForTimeout(900); }
  if (!(await p.$('.krAuthGate'))) break;
  await p.waitForTimeout(1000);
}
await p.waitForTimeout(3500);
await p.click('#btnGo', { timeout: 30000 }).catch(() => {});
await p.waitForTimeout(2500);
const chainZ = (x) => 0.000012 * x * x;
await p.evaluate(({ x, z }) => window.__fishDebug.teleport(x, z, 0), { x: 0, z: chainZ(0) + 2400 });
await p.waitForTimeout(16000);

/*
 * Measured off the PNG, not off the canvas. `createImageBitmap(canvas)` on a WebGL context
 * without preserveDrawingBuffer reads an empty buffer, which is how this first reported 0%
 * whitecaps in every sea state including the ones that are visibly streaked.
 */
const whiteFrac = async (file) => {
  const b64 = fs.readFileSync(file).toString('base64');
  const pg = await b.newPage({ viewport: { width: 400, height: 300 } });
  await pg.setContent(`<body><canvas id=c width=1280 height=800></canvas><script>
    const i=new Image(); i.onload=()=>{const g=document.getElementById('c').getContext('2d');
    g.drawImage(i,0,0);
    const y0=336,y1=736;                       // the water band, below the horizon, clear of HUD
    const d=g.getImageData(0,y0,1280,y1-y0).data;
    let w=0,n=0;
    for(let k=0;k<d.length;k+=4){n++; if(d[k]>200&&d[k+1]>212&&d[k+2]>218) w++;}
    window.__w = Math.round(10000*w/n)/100;}; i.src='data:image/png;base64,${b64}';
  </script></body>`);
  await pg.waitForFunction('window.__w !== undefined');
  const v = await pg.evaluate(() => window.__w);
  await pg.close();
  return v;
};

// The #btnSea label does not refresh, so ask the game which sea it is actually in.
const TARGET = { Calm: [0.8, 0.5], Choppy: [1.3, 1.2], Haulover: [1.6, 2.2], 'Big swell': [2.6, 1.1] };
for (let i = 0; i < 4; i++) {
  /*
   * Wait for the sea state to ARRIVE. sw/ch ramp toward the target, and this sandbox's sim clock
   * runs several times slower than the wall, so the first version screenshotted mid-transition —
   * Haulover was caught at ch 1.87 against its 2.2, and read calmer than Choppy.
   */
  for (let k = 0; k < 90; k++) {
    const s0 = await p.evaluate(() => window.__fishDebug.sea());
    const [tw, tc] = TARGET[s0.name];
    if (Math.abs(s0.sw - tw) < 0.03 && Math.abs(s0.ch - tc) < 0.03) break;
    await p.waitForTimeout(2000);
  }
  await p.waitForTimeout(3000);
  const sea = await p.evaluate(() => window.__fishDebug.sea());
  const file = `${OUT}/${sea.name.toLowerCase().replace(/\s+/g, '-')}.png`;
  await p.screenshot({ path: file });
  console.log(`${sea.name.padEnd(10)} sw=${sea.sw} ch=${sea.ch}  white in the water band: ${await whiteFrac(file)}%`);
  // KeyH, not the button: the scorebox wraps and the click was missing it entirely.
  await p.keyboard.press('KeyH'); await p.waitForTimeout(900);
}
console.log('errs', errs.slice(0, 2));
await b.close();
