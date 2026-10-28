/**
 * A trolling strike, from the hit to the jump: forces a hookup with `__fishDebug.trollStrikeNow`
 * and shoots the following seconds from over the transom.
 *
 * Usage: CLIENT_URL=http://localhost:5174 node test/capture-troll-strike.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import { CLIENT_URL } from './server.mjs';
const OUT='test/screenshots/troll-strike'; fs.mkdirSync(OUT,{recursive:true});
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1280,height:800}});
p.setDefaultTimeout(180000); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
await p.goto(process.env.CLIENT_URL || CLIENT_URL,{waitUntil:'load'}); await p.waitForTimeout(800);
const off=await p.$('button:has-text("Play offline")'); if(off){await off.click();await p.waitForTimeout(900);}
for(let i=0;i<4;i++){const t=await p.textContent('#btnQualityStart').catch(()=>'');if(t&&t.includes('High'))break;await p.keyboard.press('KeyG');await p.waitForTimeout(250);}
await p.waitForTimeout(3500);
await p.click('#btnGo'); await p.waitForTimeout(1500);
await p.evaluate(()=>window.__fishDebug.teleport(-900, 2600, Math.PI));
await p.waitForTimeout(2500);
await p.evaluate(()=>window.__fishDebug.trollToggle());
await p.keyboard.down('KeyW');
await p.waitForTimeout(12000);
// Look astern at the spread, then force the strike.
await p.mouse.move(640,400); await p.mouse.down(); await p.mouse.move(640,300,{steps:8}); await p.mouse.up();
await p.waitForTimeout(2000);
await p.evaluate(()=>window.__fishDebug.trollStrikeNow());
for(let i=0;i<10;i++){
  await p.waitForTimeout(1300);
  await p.screenshot({path:`${OUT}/t${String(i).padStart(2,'0')}.png`});
}
await p.keyboard.up('KeyW');
console.log('fight', JSON.stringify(await p.evaluate(()=>window.__fishDebug.troll())));
console.log('errs',errs.slice(0,3));
await b.close();
