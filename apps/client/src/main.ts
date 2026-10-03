// Phase 0a skeleton: proves pnpm workspace resolution of @keysrun/shared from a Vite/TS app.
// No game code (rendering, boat physics, the game loop) is ported here yet — see
// docs/ARCHITECTURE.md and the Phase 0a task notes. `three` is a declared dependency but
// unused so far.
import { depthAt, zoneAt } from '@keysrun/shared/world/depth';

// Roughly the legacy SPAWN point: open water in Boot Key Harbor, clear of the marinas.
const x = -1150;
const z = 1150;
const depth = depthAt(x, z);
const zone = zoneAt(x, z);

console.log(`[keys-run] @keysrun/shared resolved OK — depthAt(${x}, ${z}) = ${depth.toFixed(2)} m, zone = ${zone}`);

const app = document.querySelector<HTMLDivElement>('#app');
if (app) {
  app.textContent = '';
  const pre = document.createElement('pre');
  pre.textContent = [
    'Keys Run — apps/client skeleton (Phase 0a)',
    'No game code ported yet. This just proves @keysrun/shared resolves from a workspace package.',
    '',
    `depthAt(${x}, ${z}) = ${depth.toFixed(2)} m`,
    `zoneAt(${x}, ${z}) = ${zone}`,
  ].join('\n');
  app.appendChild(pre);
}
