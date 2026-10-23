/**
 * Signed distance to a real island outline (coast-data.ts, baked by scripts/coast/bake.py).
 *
 * The ellipse model answered "how far outside the shore" in closed form. A real outline has hundreds
 * of edges, and `shoreInfo` runs a few hundred times a frame plus ~740k times when depth-grid.ts is
 * built, so each island gets two small indexes at load:
 *  - a CELL x CELL grid over its box grown by CAP, each cell listing the edges that can be within CAP
 *    of any point in it (distance = min over that short list);
 *  - CELL-high rows listing the edges that span them, for the inside/outside ray test.
 *
 * Only the first CAP metres are exact. Nothing asks for more (depthAt shoals within 70 m, fish and
 * marinas look within 60 m, landH is under water past ~10 m), so beyond CAP the distance is CAP plus
 * the distance to the grown box: continuous, monotone, and cheap. Inside, it bottoms out at -CAP.
 * Pure and deterministic, like everything else in world/.
 */

/** Metres of exact distance either side of the shore. */
export const COAST_CAP = 120;
const CELL = 24;

export interface Coast {
  /** The land's own box. */
  x0: number; z0: number; x1: number; z1: number;
  /** Closed rings [x0, z0, x1, z1, ...], as baked. */
  rings: readonly (readonly number[])[];
  /** Edges, four numbers each: ax, az, bx, bz. */
  seg: Float64Array;
  gx0: number; gz0: number; nx: number; nz: number;
  cellStart: Int32Array; cellSeg: Int32Array;
  rowStart: Int32Array; rowSeg: Int32Array;
}

function segDist2(s: Float64Array, i: number, x: number, z: number): number {
  const ax = s[i], az = s[i + 1], dx = s[i + 2] - ax, dz = s[i + 3] - az;
  const L = dx * dx + dz * dz;
  let t = L > 0 ? ((x - ax) * dx + (z - az) * dz) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + dx * t - x, pz = az + dz * t - z;
  return px * px + pz * pz;
}

/** Buckets edges into lists: for each bucket in [lo(i), hi(i)] of edge i, as CSR arrays. */
function csr(n: number, buckets: number, range: (i: number, add: (b: number) => void) => void): [Int32Array, Int32Array] {
  const count = new Int32Array(buckets + 1);
  for (let i = 0; i < n; i++) range(i, (b) => { count[b + 1]++; });
  for (let b = 0; b < buckets; b++) count[b + 1] += count[b];
  const fill = count.slice(0, buckets), out = new Int32Array(count[buckets]);
  for (let i = 0; i < n; i++) range(i, (b) => { out[fill[b]++] = i; });
  return [count, out];
}

export function buildCoast(rings: readonly (readonly number[])[]): Coast {
  let n = 0;
  for (const r of rings) n += r.length / 2;
  const seg = new Float64Array(n * 4);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, k = 0;
  for (const r of rings) {
    const m = r.length / 2;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      seg[k++] = r[i * 2]; seg[k++] = r[i * 2 + 1]; seg[k++] = r[j * 2]; seg[k++] = r[j * 2 + 1];
      x0 = Math.min(x0, r[i * 2]); x1 = Math.max(x1, r[i * 2]); z0 = Math.min(z0, r[i * 2 + 1]); z1 = Math.max(z1, r[i * 2 + 1]);
    }
  }
  const gx0 = x0 - COAST_CAP, gz0 = z0 - COAST_CAP;
  const nx = Math.ceil((x1 - x0 + 2 * COAST_CAP) / CELL), nz = Math.ceil((z1 - z0 + 2 * COAST_CAP) / CELL);
  // An edge belongs to every cell whose centre is within CAP + half a cell diagonal of it, so the
  // list of the cell a point falls in holds every edge within CAP of that point.
  const reach = COAST_CAP + CELL * Math.SQRT1_2, reach2 = reach * reach;
  const [cellStart, cellSeg] = csr(n, nx * nz, (i, add) => {
    const o = i * 4;
    const cx0 = Math.max(0, Math.floor((Math.min(seg[o], seg[o + 2]) - reach - gx0) / CELL));
    const cx1 = Math.min(nx - 1, Math.floor((Math.max(seg[o], seg[o + 2]) + reach - gx0) / CELL));
    const cz0 = Math.max(0, Math.floor((Math.min(seg[o + 1], seg[o + 3]) - reach - gz0) / CELL));
    const cz1 = Math.min(nz - 1, Math.floor((Math.max(seg[o + 1], seg[o + 3]) + reach - gz0) / CELL));
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      if (segDist2(seg, o, gx0 + (cx + 0.5) * CELL, gz0 + (cz + 0.5) * CELL) <= reach2) add(cz * nx + cx);
    }
  });
  const [rowStart, rowSeg] = csr(n, nz, (i, add) => {
    const o = i * 4;
    const r0 = Math.max(0, Math.floor((Math.min(seg[o + 1], seg[o + 3]) - gz0) / CELL));
    const r1 = Math.min(nz - 1, Math.floor((Math.max(seg[o + 1], seg[o + 3]) - gz0) / CELL));
    for (let r = r0; r <= r1; r++) add(r);
  });
  return { x0, z0, x1, z1, rings, seg, gx0, gz0, nx, nz, cellStart, cellSeg, rowStart, rowSeg };
}

/** True if (x, z) is on the land: an even-odd ray test against the edges spanning its row. */
export function coastInside(c: Coast, x: number, z: number): boolean {
  if (x < c.x0 || x > c.x1 || z < c.z0 || z > c.z1) return false;
  const r = Math.floor((z - c.gz0) / CELL), s = c.seg;
  let inside = false;
  for (let k = c.rowStart[r], e = c.rowStart[r + 1]; k < e; k++) {
    const o = c.rowSeg[k] * 4;
    const az = s[o + 1], bz = s[o + 3];
    if ((az > z) !== (bz > z)) {
      const ix = s[o] + ((z - az) / (bz - az)) * (s[o + 2] - s[o]);
      if (ix > x) inside = !inside;
    }
  }
  return inside;
}

/** Signed distance to the shore in metres: negative on land. Exact within COAST_CAP. */
export function coastDist(c: Coast, x: number, z: number): number {
  const gx = x - c.gx0, gz = z - c.gz0, W = c.nx * CELL, H = c.nz * CELL;
  if (gx < 0 || gz < 0 || gx >= W || gz >= H) {
    const ox = gx < 0 ? -gx : gx > W ? gx - W : 0, oz = gz < 0 ? -gz : gz > H ? gz - H : 0;
    return COAST_CAP + Math.hypot(ox, oz);
  }
  const cell = Math.floor(gz / CELL) * c.nx + Math.floor(gx / CELL), s = c.seg;
  let best = COAST_CAP * COAST_CAP;
  for (let k = c.cellStart[cell], e = c.cellStart[cell + 1]; k < e; k++) {
    const d2 = segDist2(s, c.cellSeg[k] * 4, x, z);
    if (d2 < best) best = d2;
  }
  const d = Math.sqrt(best);
  return coastInside(c, x, z) ? -d : d;
}
