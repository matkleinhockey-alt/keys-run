/**
 * One shot of each kind of structure in the offshore rig field (entities/life/hotspots.ts's
 * RIG_SITES): the manned production platform, the small unmanned wellhead, and the jack-up with
 * its legs running up through the hull.
 *
 * Usage: CLIENT_URL=http://localhost:5174 node test/capture-rigs.mjs
 * Output: apps/client/test/screenshots/rigs/
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { CLIENT_URL } from './server.mjs';
const OUT='test/screenshots/rigs'; fs.mkdirSync(OUT,{recursive:true});
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1280,height:800}});
p.setDefaultTimeout(180000); p.on('pageerror',e=>console.log('pageerror',String(e)));
await p.goto(process.env.CLIENT_URL || CLIENT_URL,{waitUntil:'load'}); await p.waitForTimeout(800);
const off=await p.$('button:has-text("Play offline")'); if(off){await off.click();await p.waitForTimeout(900);}
for(let i=0;i<4;i++){const t=await p.textContent('#btnQualityStart').catch(()=>'');if(t&&t.includes('High'))break;await p.keyboard.press('KeyG');await p.waitForTimeout(250);}
await p.waitForTimeout(4000);
await p.click('#btnGo'); await p.waitForTimeout(2000);
const chainZ=(x)=>0.000012*x*x;
const sites=[['satellite',-4400,2900],['platform',-3250,2950],['jackup',-2100,2650]];
for(const [name,x,dz] of sites){
  const z=chainZ(x)+dz;
  // Sit off to one side and point the bow at it so the chase cam frames it.
  const bx=x+70, bz=z+105;
  // Aim a little left of the rig so it frames right of centre, clear of the HUD panel.
  const h=Math.atan2(-(x-bx),-(z-bz))+0.40;
  await p.evaluate(({bx,bz,h})=>window.__fishDebug.teleport(bx,bz,h),{bx,bz,h});
  await p.waitForTimeout(7000);
  await p.screenshot({path:`${OUT}/${name}.png`});
  console.log(name,'at',x,z.toFixed(0));
}
await b.close();
