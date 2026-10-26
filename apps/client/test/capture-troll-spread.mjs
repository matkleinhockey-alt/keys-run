/**
 * The trolling spread in the water: riggers out, lines streaming astern, lures skipping on the
 * surface (game/fishing/troll-spread.ts). Runs the boat up to trolling speed offshore, then looks
 * back over the transom.
 *
 * Usage: CLIENT_URL=http://localhost:5174 node test/capture-troll-spread.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT='test/screenshots/troll-spread'; fs.mkdirSync(OUT,{recursive:true});
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1280,height:800}});
p.setDefaultTimeout(180000); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
await p.goto(process.env.CLIENT_URL || 'http://localhost:5174',{waitUntil:'load'}); await p.waitForTimeout(800);
const off=await p.$('button:has-text("Play offline")'); if(off){await off.click();await p.waitForTimeout(900);}
for(let i=0;i<4;i++){const t=await p.textContent('#btnQualityStart').catch(()=>'');if(t&&t.includes('High'))break;await p.keyboard.press('KeyG');await p.waitForTimeout(250);}
await p.waitForTimeout(3500);
await p.click('#btnGo'); await p.waitForTimeout(1500);
// Offshore, in deep water where you would actually troll.
await p.evaluate(()=>window.__fishDebug.teleport(-900, 2600, Math.PI));
await p.waitForTimeout(3000);
await p.evaluate(()=>window.__fishDebug.trollToggle());
await p.waitForTimeout(1000);
// Get under way so the spread streams astern, then look back over the transom.
await p.keyboard.down('KeyW');
await p.waitForTimeout(14000);
console.log('troll', JSON.stringify(await p.evaluate(()=>window.__fishDebug.troll())));
await p.mouse.move(640,400); await p.mouse.down(); await p.mouse.move(640,300,{steps:8}); await p.mouse.up();
await p.waitForTimeout(3000);
await p.screenshot({path:`${OUT}/astern.png`});
await p.keyboard.up('KeyW');
console.log('errs',errs.slice(0,3));
await b.close();
