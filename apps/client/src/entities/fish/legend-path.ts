/**
 * Where the gold bluefin are, as a function of the wall clock.
 *
 * `instantiateLegend` used to place them from the world seed and then let `stepSchool` wander them
 * on SESSION time. That made "they are always somewhere you could drive out and find" true for
 * each player separately: two people who logged in an hour apart were each looking at a school
 * that had wandered a different hour from the same start, so one could never tell the other where
 * they were. Their position is world content, so it is now a pure function of
 * `(world seed, Date.now())` and every client evaluates the same curve - the same idea as
 * `sandbarIndexAt` in life/sandbar.ts.
 *
 * ## Continuous, not periodic jumps
 *
 * The sandbar hashes a clock PERIOD and teleports between periods, because nobody watches a
 * sandbar move. A tuna is watched, so this is a closed loop through the water that is traversed
 * at a speed set by the clock: position is continuous in time and nothing ever pops.
 *
 * ## Legal water is built in, not checked
 *
 * They must stay in >=14 m of water, >=60 m off any shore, inside the chart. A continuous path
 * cannot reject-and-resample (the spawn code's trick), and a free sum-of-sinusoids wander
 * wanders onto the Keys within minutes. So the loop is routed on a coarse grid of cells that
 * are each legal with a wide margin (A* between hashed, well-separated targets), then rounded
 * with Chaikin corner-cutting. Cutting a corner moves the curve at most a quarter of a segment
 * from the grid route, which the margin absorbs; the result is re-sampled densely and the
 * smoothing is backed off if it ever does leave legal water. test/legend-path.test.ts re-checks
 * a simulated 24 h.
 */
import { hashCell } from '@keysrun/shared/rng';
import { depthAt, WB } from '@keysrun/shared/world/depth';
import { shoreInfo } from '@keysrun/shared/world/chain';

/** Hard floors the brief sets; the grid uses wider margins so smoothing cannot cross them. */
export const LEGEND_MIN_DEPTH = 14;
export const LEGEND_MIN_SHORE = 60;
const CELL = 100;
/** A cell is routable only if its centre AND its four corners clear the floors by this much, so a
 * rounded corner (which can sit ~CELL/4 off the grid route) is still legal. */
const SHORE_MARGIN = 70;
const DEPTH_MARGIN = 6;
/** Mean travel speed, m/s. The species' cruise is 3.4 m/s; a school that is going somewhere
 * averages well under that. */
const MEAN_SPEED = 1.3;
/** Slow surges on top of the mean so the school dawdles and hurries. [amplitude m, period s];
 * the derivatives 2*pi*A/P (0.58 + 0.58 m/s) must sum under MEAN_SPEED or they would back up
 * along the path - the first cut (900 m / 260 m) summed to 2.3 m/s over a 1.3 m/s mean, so the
 * school reversed for minutes at a time and peaked at 3.6 m/s, over the species' own cruise. */
const SURGES: ReadonlyArray<readonly [number, number]> = [[500, 5400], [120, 1300]];
const TARGETS = 7;
const SALT = 7718;

interface Loop { pts: Float64Array; n: number; len: number; offset: number; step: number }
const cache = new Map<string, Loop | null>();

function legalAt(x: number, z: number, dMin: number, shoreMin: number): boolean {
  return x >= WB.x0 + 40 && x <= WB.x1 - 40 && z >= WB.z0 + 40 && z <= WB.z1 - 40
    && depthAt(x, z) >= dMin && shoreInfo(x, z).d >= shoreMin;
}

function build(seed: number, dMin: number): Loop | null {
  const gx = Math.ceil((WB.x1 - WB.x0) / CELL), gz = Math.ceil((WB.z1 - WB.z0) / CELL);
  const ok = new Uint8Array(gx * gz);
  const wd = Math.max(dMin, LEGEND_MIN_DEPTH) + DEPTH_MARGIN, ws = LEGEND_MIN_SHORE + SHORE_MARGIN;
  const cx = (i: number) => WB.x0 + (i + 0.5) * CELL, cz = (j: number) => WB.z0 + (j + 0.5) * CELL;
  for (let j = 0; j < gz; j++) for (let i = 0; i < gx; i++) {
    const x = cx(i), z = cz(j), h = CELL / 2;
    ok[j * gx + i] = legalAt(x, z, wd, ws) && legalAt(x - h, z - h, wd, ws) && legalAt(x + h, z - h, wd, ws)
      && legalAt(x - h, z + h, wd, ws) && legalAt(x + h, z + h, wd, ws) ? 1 : 0;
  }
  // Only the biggest connected body of legal water is usable; the rest are ponds the school
  // could never reach.
  const comp = new Int32Array(gx * gz).fill(-1);
  let best = -1, bestSize = 0, nc = 0;
  for (let s = 0; s < ok.length; s++) {
    if (!ok[s] || comp[s] >= 0) continue;
    const q = [s]; comp[s] = nc; let size = 0;
    while (q.length) {
      const c = q.pop()!; size++;
      const ci = c % gx, cj = (c - ci) / gx;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= gx || nj >= gz) continue;
        const n = nj * gx + ni;
        if (ok[n] && comp[n] < 0) { comp[n] = nc; q.push(n); }
      }
    }
    if (size > bestSize) { bestSize = size; best = nc; }
    nc++;
  }
  if (best < 0) return null;
  const cells: number[] = [];
  for (let s = 0; s < ok.length; s++) if (comp[s] === best) cells.push(s);

  // Targets: from a hashed pool, always the one farthest from those already chosen, so the loop
  // spans the chart instead of circling the first spot the hash liked.
  const pool: number[] = [];
  for (let k = 0; k < 40; k++) pool.push(cells[Math.floor(hashCell(seed, SALT, k, 1) * cells.length)]);
  const pos = (c: number): [number, number] => [cx(c % gx), cz(Math.floor(c / gx))];
  const chosen = [pool[0]];
  while (chosen.length < TARGETS) {
    let bc = pool[0], bd = -1;
    for (const c of pool) {
      const [x, z] = pos(c);
      let dmin = 1e18;
      for (const o of chosen) { const [ox, oz] = pos(o); dmin = Math.min(dmin, Math.hypot(x - ox, z - oz)); }
      if (dmin > bd) { bd = dmin; bc = c; }
    }
    chosen.push(bc);
  }

  // A* (8-connected, no corner cutting through illegal cells).
  const astar = (a: number, b: number): number[] => {
    const g = new Map<number, number>([[a, 0]]), from = new Map<number, number>();
    const open: Array<[number, number]> = [[0, a]], done = new Set<number>();
    const [bx, bz] = pos(b);
    while (open.length) {
      let mi = 0;
      for (let k = 1; k < open.length; k++) if (open[k][0] < open[mi][0]) mi = k;
      const c = open.splice(mi, 1)[0][1];
      if (c === b) break;
      if (done.has(c)) continue;
      done.add(c);
      const ci = c % gx, cj = (c - ci) / gx;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= gx || nj >= gz || !ok[nj * gx + ni]) continue;
        if (di && dj && (!ok[cj * gx + ni] || !ok[nj * gx + ci])) continue;
        const n = nj * gx + ni, ng = g.get(c)! + (di && dj ? 1.414 : 1);
        if (ng < (g.get(n) ?? 1e18)) {
          g.set(n, ng); from.set(n, c);
          open.push([ng + Math.hypot(cx(ni) - bx, cz(nj) - bz) / CELL, n]);
        }
      }
    }
    const out = [b];
    while (out[out.length - 1] !== a) {
      const p = from.get(out[out.length - 1]);
      if (p === undefined) return [];
      out.push(p);
    }
    return out.reverse();
  };
  const route: number[] = [];
  for (let k = 0; k < chosen.length; k++) {
    const leg = astar(chosen[k], chosen[(k + 1) % chosen.length]);
    if (!leg.length) return null;
    for (let m = k ? 1 : 0; m < leg.length - (k === chosen.length - 1 ? 1 : 0); m++) route.push(leg[m]);
  }

  // Round it, and back off the rounding if the result ever leaves legal water.
  // Where one A* leg retraces the last, the route goes out and straight back along the same cells.
  // Rounded, that is a hairpin with the school turning 180 degrees on the spot (measured: heading
  // flipping at 180 deg/s). Cancel any A-B-A so the loop is a loop, not a loop with whiskers.
  const clean: number[] = [];
  for (const c of route) {
    if (clean.length >= 2 && clean[clean.length - 2] === c) clean.pop(); else clean.push(c);
  }
  const raw = clean.map(pos);
  for (let iters = 4; iters >= 0; iters--) {
    let p = raw;
    for (let it = 0; it < iters; it++) {
      const q: Array<[number, number]> = [];
      for (let k = 0; k < p.length; k++) {
        const a = p[k], b = p[(k + 1) % p.length];
        q.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]], [0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
      }
      p = q;
    }
    // Uniform arc-length resample, so a time step is a distance step.
    let len = 0;
    const seg: number[] = [];
    for (let k = 0; k < p.length; k++) { const b = p[(k + 1) % p.length]; seg.push(Math.hypot(b[0] - p[k][0], b[1] - p[k][1])); len += seg[k]; }
    const n = Math.floor(len / 20);
    const pts = new Float64Array(n * 2);
    let k = 0, acc = 0, valid = true;
    for (let s = 0; s < n; s++) {
      const target = (s * len) / n;
      while (acc + seg[k] < target) { acc += seg[k]; k++; }
      const u = seg[k] ? (target - acc) / seg[k] : 0, a = p[k], b = p[(k + 1) % p.length];
      pts[s * 2] = a[0] + (b[0] - a[0]) * u; pts[s * 2 + 1] = a[1] + (b[1] - a[1]) * u;
      if (!legalAt(pts[s * 2], pts[s * 2 + 1], Math.max(dMin, LEGEND_MIN_DEPTH) + 1, LEGEND_MIN_SHORE + 5)) { valid = false; break; }
    }
    if (valid) {
      // Starting phase is hashed so the school is not at the loop's first corner at the epoch.
      return { pts, n, len, step: len / n, offset: hashCell(seed, SALT, 99, 2) * len };
    }
  }
  return null;
}

function loopFor(seed: number, dMin: number): Loop | null {
  const key = `${seed}:${dMin}`;
  if (!cache.has(key)) cache.set(key, build(seed, dMin));
  return cache.get(key)!;
}

export interface LegendPose { x: number; z: number; heading: number; speed: number }

/** Distance travelled along the loop at wall-clock `tSec`, before wrapping. */
function arc(tSec: number, phase: number): number {
  let s = MEAN_SPEED * tSec;
  SURGES.forEach(([A, P], i) => { s += A * Math.sin((2 * Math.PI * tSec) / P + phase * (i + 1) * 6.283); });
  return s;
}

/**
 * The school's position at a wall-clock instant. Pure: same `(seed, wallMs)` -> same answer on
 * every client. `dMin` is the species' own depth floor (tightened to at least 14 m internally).
 * Heading uses the game's convention (forward = (-sin h, -cos h)). Null only if the chart has
 * no usable water at all.
 */
export function legendPoseAt(seed: number, wallMs: number, dMin: number): LegendPose | null {
  const L = loopFor(seed, dMin);
  if (!L) return null;
  const phase = hashCell(seed, SALT, 98, 3);
  const at = (ms: number): [number, number] => {
    const s = (((arc(ms / 1000, phase) + L.offset) % L.len) + L.len) % L.len;
    const f = s / L.step, i = Math.floor(f) % L.n, u = f - Math.floor(f), j = (i + 1) % L.n;
    return [L.pts[i * 2] * (1 - u) + L.pts[j * 2] * u, L.pts[i * 2 + 1] * (1 - u) + L.pts[j * 2 + 1] * u];
  };
  const [x, z] = at(wallMs);
  // Heading from a +-15 s chord, not the instantaneous tangent: where the route doubles back the
  // tangent flips 180 degrees in a frame, and the chord turns the school through it over ~30 s.
  const [x2, z2] = at(wallMs + 15000), [x1, z1] = at(wallMs - 15000);
  const dx = x2 - x1, dz = z2 - z1;
  return { x, z, heading: Math.atan2(-dx, -dz), speed: Math.hypot(dx, dz) / 30 };
}

/** Loop length in metres (for tests and the debug readout). */
export function legendLoopLength(seed: number, dMin: number): number { return loopFor(seed, dMin)?.len ?? 0; }
