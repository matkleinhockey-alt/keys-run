import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT='test/screenshots/uw-polish'; fs.mkdirSync(OUT,{recursive:true});
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1280,height:800}});
p.setDefaultTimeout(180000); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
await p.goto('http://localhost:5174',{waitUntil:'load'}); await p.waitForTimeout(800);
const off=await p.$('button:has-text("Play offline")'); if(off){await off.click();await p.waitForTimeout(900);}
for(let i=0;i<4;i++){const t=await p.textContent('#btnQualityStart').catch(()=>'');if(t&&t.includes('High'))break;await p.keyboard.press('KeyG');await p.waitForTimeout(250);}
await p.waitForTimeout(3500);
await p.click('#btnGo'); await p.waitForTimeout(1500);
// Coffins Patch, a real patch reef.
const chainZ=(x)=>0.000012*x*x;
const X=2700, Z=chainZ(2700)+1050;
await p.evaluate(({x,z})=>window.__fishDebug.teleport(x,z,0),{x:X,z:Z});
await p.waitForTimeout(3000);
await p.evaluate(()=>{document.querySelector('#btnDive')?.click();});
await p.waitForTimeout(1500);
const d = await p.evaluate(()=>{const s=window.__diverDebug.state();return s?+(-s.y).toFixed(1):null;});
console.log('dive mode:', await p.evaluate(()=>window.__diverDebug.mode()), 'depth', d);
// Settle a few metres down and look level, where the reef and the gun are both in shot.
await p.evaluate(()=>window.__diverDebug.setDepth(7));
await p.evaluate(()=>window.__diverDebug.look && window.__diverDebug.look(0,-0.12));
await p.waitForTimeout(7000);
await p.screenshot({path:`${OUT}/reef.png`});
console.log('errs',errs.slice(0,3));
await b.close();
