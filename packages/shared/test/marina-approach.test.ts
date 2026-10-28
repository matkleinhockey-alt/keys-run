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
import { MARINAS, MARINA_CUT, depthAt, landH } from '../src/world/depth.js';
import { channelMarks, marinaEntranceMarks } from '../src/world/channel-marks.js';
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

describe('the entrance is marked', () => {
  it('puts a red and a green pair down each marina entrance', () => {
    const marks = marinaEntranceMarks();
    expect(marks.length).toBe(MARINAS.length * 4);        // two pairs each
    for (const M of MARINAS) {
      const mine = marks.filter((k) => Math.abs(k.x - M.sx) < MARINA_CUT.halfW + 1);
      expect(mine.filter((k) => k.hand === 'red').length, M.name).toBe(2);
      expect(mine.filter((k) => k.hand === 'green').length, M.name).toBe(2);
    }
  });

  it('keeps red to starboard coming in — red right returning', () => {
    /*
     * IALA Region B. Entering means r decreasing, i.e. heading -dir along z; starboard for that
     * heading is +dir in x (the same right-hand vector the hull integrator uses). So every red
     * must be on the +dir side of its marina's centreline and every green opposite.
     */
    for (const M of MARINAS) {
      for (const k of marinaEntranceMarks().filter((q) => Math.abs(q.x - M.sx) < MARINA_CUT.halfW + 1)) {
        const side = (k.x - M.sx) * M.dir;
        if (k.hand === 'red') expect(side, `${M.name}: red ${k.n} is on the wrong hand`).toBeGreaterThan(0);
        else expect(side, `${M.name}: green ${k.n} is on the wrong hand`).toBeLessThan(0);
      }
    }
  });

  it('stands the marks in the water, outside the fairway', () => {
    for (const k of marinaEntranceMarks()) {
      expect(landH(k.x, k.z), `mark ${k.n} is on dry land`).toBeLessThanOrEqual(0.02);
      expect(depthAt(k.x, k.z), `mark ${k.n} is aground`).toBeGreaterThan(1);
    }
  });

  it('leaves the fairway between them clear for the deepest boat', () => {
    for (const M of MARINAS) {
      for (let r = MARINA_CUT.r0; r <= MARINA_CUT.r1 - 20; r += 5) {
        for (const dx of [-25, 0, 25]) {
          const x = M.sx + dx, z = M.sz + M.dir * r;
          expect(depthAt(x, z), `${M.name}: ${dx}m off centre, ${r}m out`).toBeGreaterThan(DEEPEST + 0.3);
        }
      }
    }
  });
});

describe('the north-south cuts', () => {
  it('are marked red-on-the-right too, which they were not', () => {
    // `marksForRect` had red on the smaller-x side of every north-south cut — backwards, and the
    // opposite of what its own doc comment promised. Seaward is +z, so you enter heading -z, and
    // starboard for that heading is +x.
    const cut = { x0: -2000, x1: -1560, dz0: 150, dz1: 800, d: 4.2 };
    const mid = (cut.x0 + cut.x1) / 2;
    // Scoped to the cut's own x range: channelMarks appends the marina entrance marks too.
    for (const k of channelMarks([cut], []).filter((q) => q.x > cut.x0 - 5 && q.x < cut.x1 + 5)) {
      if (k.hand === 'red') expect(k.x, `red ${k.n}`).toBeGreaterThan(mid);
      else expect(k.x, `green ${k.n}`).toBeLessThan(mid);
    }
  });
});
