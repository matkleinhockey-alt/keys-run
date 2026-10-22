import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await b.newPage(); p.setDefaultTimeout(300000);
p.on('console', (m) => console.log('console:', m.type(), m.text().slice(0, 200)));
await p.goto('http://localhost:5174', { waitUntil: 'load' });
for (const t of [1000, 3000, 6000]) { await p.waitForTimeout(t); console.log(t, 'gate', await p.locator('.krAuthGate').count(), 'offline', await p.locator('.krAuthOffline').count()); }
await p.locator('.krAuthOffline').click(); await p.waitForTimeout(2000);
console.log('after click gate', await p.locator('.krAuthGate').count());
await b.close();
