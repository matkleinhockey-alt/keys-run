/**
 * You can get to the dock.
 *
 * The basins were dredged to 3.2 m and nothing connected them to navigable water. Walking out
 * along its own axis, the town marina ran 3.2 m to 70 m, then 0.5 and 0.4, then seventy metres
 * of LAND standing 1.7 m proud, and only then the harbour approach — so the deepest hull in the
 * game could not reach the marina the player spawns at, and the shallower ones only got in by a
 * 930 m detour west. Keys Fisheries had a 50 m shoal of 0.4 m across its mouth.
 *
 * This is a reachability test, not a depth-at-a-point test, because that was the bug: every
 * individual number was fine and there was no way through.
 */
import { describe, expect, it } from 'vitest';
import { MARINAS, depthAt, landH } from '../src/world/depth.js';
import { BOATS } from '../src/content/boats.js';
import { inTownFootprint } from '../src/world/town.js';

const DEEPEST = Math.max(...BOATS.map((b) => b.draft));

/** Breadth-first from the dock over a 10 m grid: can a hull of this draft get to open water? */
function escapes(M: { sx: number; sz: number; dir: number }, draft: number): boolean {
  const STEP = 10, LIMIT = 1400;
  const toWorld = (i: number, j: number): [number, number] => [M.sx + i * STEP, M.sz + M.dir * (20 + j * STEP)];
  const seen = new Set(['0,0']);
  const q: Array<[number, number]> = [[0, 0]];
  while (q.length) {
    const [i, j] = q.shift()!;
    const [wx, wz] = toWorld(i, j);
    if (Math.hypot(wx - M.sx, wz - M.sz) > 900) return true;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const ni = i + di, nj = j + dj;
      if (Math.abs(ni) * STEP > LIMIT || Math.abs(nj) * STEP > LIMIT) continue;
      const k = `${ni},${nj}`;
      if (seen.has(k)) continue;
      const [nx, nz] = toWorld(ni, nj);
      if (landH(nx, nz) > 0.02 || depthAt(nx, nz) <= draft) continue;
      seen.add(k); q.push([ni, nj]);
    }
  }
  return false;
}

describe('every marina', () => {
  it('can be reached by every boat in the game', () => {
    for (const M of MARINAS) {
      for (const b of BOATS) {
        expect(escapes(M, b.draft), `${b.brand} ${b.name} (${b.draft} m) cannot reach ${M.name}`).toBe(true);
      }
    }
  });

  it('has water the whole way out along its own axis, not just a way round', () => {
    // The shallow boats could always get to the town marina — by going 930 m west and back. An
    // approach you cannot see from the dock is not an approach.
    for (const M of MARINAS) {
      for (let r = 0; r <= 180; r += 5) {
        const x = M.sx, z = M.sz + M.dir * r;
        expect(landH(x, z), `${M.name}: land ${r} m off the dock`).toBeLessThanOrEqual(0.02);
        expect(depthAt(x, z), `${M.name}: only ${depthAt(x, z).toFixed(2)} m of water ${r} m off the dock`)
          .toBeGreaterThan(DEEPEST + 0.3);
      }
    }
  });

  it('is dredged, not flattened — the channel keeps its banks', () => {
    // A cut wide enough to lose the shoreline would read as the land having been deleted.
    const wide = MARINAS.map((M) => {
      let land = 0, n = 0;
      for (let r = 70; r <= 150; r += 5) for (const dx of [-60, -45, 45, 60]) {
        n++; if (landH(M.sx + dx, M.sz + M.dir * r) > 0.02) land++;
      }
      return { name: M.name, land, n };
    });
    // The town marina's mouth had seventy metres of land across it; some of that has to survive
    // either side of the channel.
    const boot = wide.find((w) => w.name.startsWith('Boot Key'))!;
    expect(boot.land, 'the channel has eaten its own banks').toBeGreaterThan(0);
  });

  it('does not cut through the town', () => {
    for (const M of MARINAS) {
      for (let r = 50; r <= 170; r += 5) for (let dx = -40; dx <= 40; dx += 5) {
        const x = M.sx + dx, z = M.sz + M.dir * r;
        if (landH(x, z) > 0.02) continue;
        expect(inTownFootprint(x, z), `${M.name}: dredged open water inside the town at ${dx},${r}`).toBe(false);
      }
    }
  });
});
