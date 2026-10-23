// Writes scripts/coast/game-islands.json: each island's footprint (name, x, z, a, b, th) from chain.ts,
// which bake.py fits the real outlines onto. Footprints come from ISL_DEF/MIAMI_ISL and never from
// the baked coast, so re-running this does not drift. After `pnpm --filter @keysrun/shared build`:
//   node scripts/coast/dump-game.mjs && python3 -I scripts/coast/bake.py
import { writeFileSync } from 'node:fs';
import { islands } from '../../packages/shared/dist/world/chain.js';
writeFileSync(new URL('./game-islands.json', import.meta.url), JSON.stringify(islands.map(({ name, x, z, a, b, th }) => ({ name, x, z, a, b, th })), null, 1));
