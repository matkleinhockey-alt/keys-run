/**
 * Close-ups of the first-person reel, orbited. The rod view model hangs off the camera, so moving
 * the camera moves the rod with it and the reel can never be framed from the game — hence
 * rod-harness.ts's `__rod.inspect(true)`, which re-parents the rod into the scene, and `__rod.cam`
 * to place a free camera. Six shots around it at eye height.
 *
 * Usage: CLIENT_URL=http://localhost:5174 node test/capture-reel.mjs
 * Output: apps/client/test/screenshots/rod/reel-*.png
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { CLIENT_URL } from './server.mjs';
const OUT='test/screenshots/rod'; fs.mkdirSync(OUT,{recursive:true});
const b=await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
const p=await b.newPage({viewport:{width:900,height:700},deviceScaleFactor:2});
p.setDefaultTimeout(120000); p.on('pageerror',e=>console.log('pageerror',String(e)));
await p.goto((process.env.CLIENT_URL || CLIENT_URL) + '/test/rod-harness.html',{waitUntil:'load'});
await p.waitForTimeout(2500);
await p.evaluate(()=>window.__rod.setFp(true));
await p.evaluate(()=>window.__rod.inspect(true));
await p.waitForTimeout(400);
const at = await p.evaluate(()=>window.__rod.reelAt());
console.log('reel at', JSON.stringify(at));
if(!at){ await b.close(); process.exit(1); }
const [x,y,z]=at;
// Three angles around the reel, close in.
const R=0.21, shots=[];
for(let i=0;i<6;i++){const a=i*Math.PI/3; shots.push([String(i),[x+R*Math.cos(a), y+0.07, z+R*Math.sin(a)]]);}
for(const [n,pos] of shots){
  await p.evaluate(({pos,look})=>window.__rod.cam(pos,look),{pos,look:[x,y,z]});
  await p.waitForTimeout(700);
  await p.screenshot({path:`${OUT}/reel-${n}.png`});
}
await b.close(); console.log('ok');
