#!/usr/bin/env node
/**
 * Regenerates packages/shared/src/content/estates-plat.ts, the Keys Run Estates plat, against the
 * live world in packages/shared/dist (build it first):
 *
 *   pnpm --filter @keysrun/shared build && node scripts/estates/plat.mjs
 *
 * Input is seed-plat.json beside this script: the plat as first approved (cut against the old
 * ellipse islands), which fixes every lot's id, name, island, tier and side, and roughly where it
 * is. Ids are database keys (apps/api `estates.parcel_id`), so they never come from geometry.
 *
 * For each island the script rasters the ground at CELL m and keeps the buildable cells: dry
 * (landH > DRY), on that island, ≥ GAP m from creeks, the town pad, the golf courses, the airfield
 * fill and the marinas, and off US-1 and its verge. Each buildable cell goes to the nearest seed lot on the island, if that lot
 * is within REACH m (or the cell is on the way from the seed out to a real shore within SHORE_REACH
 * m, so a lot whose seed shore is now inland grows out to the water; private islands take the whole
 * key) and the cell is not in the strip between a
 * Bayside and an Oceanside lot (the seed plat's spine). Each lot keeps its largest 4-connected piece,
 * its holes filled; the outline is traced round the cells and simplified to SIMPLIFY m. A lot with
 * less than MIN_AREA m² (MIN_PRIVATE for a private island) or no spot CLEAR m from its edge is
 * dropped and listed on stdout. Harbor Row is laid out on the town pad in town.ts's frame.
 *
 * Deterministic: same seed + same world → byte-identical output. Not a fixed point of itself: it
 * always starts from the seed, never from the plat it wrote.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DIST = join(ROOT, 'packages/shared/dist');
const OUT = join(ROOT, 'packages/shared/src/content/estates-plat.ts');

const { chainZ, islands, islandDist, islandLocal, shoreInfo } = await import(join(DIST, 'world/chain.js'));
const { landH, creekDist, onCourse, onUS1Fill, US1_HALF, GOLF, RUNWAY, MARINAS } = await import(join(DIST, 'world/depth.js'));
const { inTownFootprint, marinaDeckBoxes, marinaShedRect, toWorld, TOWN_FRAME } = await import(join(DIST, 'world/town.js'));

const CELL = 3;          // raster, m
const DRY = 0.3;         // the dry-land line: estates.ts's dryGround uses the same
const GAP = 14;          // m kept clear of creeks, the town pad, courses, airfield, marinas
const ROAD_VERGE = 6;    // m kept clear either side of US-1's roadway
const REACH = 40;        // m a lot may grow past its seed outline onto land the seed missed
const SHORE_REACH = 140; // ...or out to the real shore, if it is within this far of the seed
const SPINE = 12;        // a cell outside every seed must be this much nearer its own side than the other
const SIMPLIFY = 1.5;    // Douglas-Peucker tolerance, m
const MIN_AREA = 1500;   // m²
const MIN_PRIVATE = 800; // m², a whole key
const CLEAR = 6;         // m: a lot needs a spot this far inside its edge (its label point)

const seeds = JSON.parse(readFileSync(join(HERE, 'seed-plat.json'), 'utf8'));
const r1 = (v) => Math.round(v * 10) / 10;

/* ---------------------------------------------------------------- world masks */

function islandFor(s) {
  const named = islands.filter((I) => I.name === s.island);
  const [cx, cz] = polyCentroid(s.poly);
  if (named.length === 1) return named[0];
  const pool = named.length ? named : islands;
  let best = null, bd = Infinity;
  for (const I of pool) { const d = islandDist(I, cx, cz); if (d < bd) { bd = d; best = I; } }
  return best;
}

const marinaRects = MARINAS.flatMap((m) => [
  ...marinaDeckBoxes(m).map((b) => ({ x0: b.cx - b.w / 2, x1: b.cx + b.w / 2, z0: b.cz - b.d / 2, z1: b.cz + b.d / 2 })),
  marinaShedRect(m),
]);
const rectDist = (r, x, z) => Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1));

/** The made ground depth.ts's inFill raises for the golf courses and the airfield (runway, apron and
 * terminal), grown by GAP. The town pad's share is inTownFootprint below. */
function onFill(x, z) {
  for (const G of GOLF) {
    const [lx, lz] = islandLocal(G.I, x, z);
    if (Math.hypot((lx - G.lx) / (G.ra + GAP), (lz - G.lz) / (G.rb + GAP)) < 1.06) return true;
  }
  const [lx, lz] = islandLocal(RUNWAY.I, x, z);
  return lx > RUNWAY.lx0 - 30 - GAP && lx < RUNWAY.lx1 + 30 + GAP && lz > RUNWAY.lz - RUNWAY.w / 2 - 4 - GAP && lz < RUNWAY.lz + 95 + GAP;
}

function buildable(I, x, z) {
  if (islandDist(I, x, z) >= 0 || shoreInfo(x, z).isl !== I) return false;
  if (landH(x, z) <= DRY) return false;
  if (creekDist(x, z) < GAP || inTownFootprint(x, z, GAP) || onFill(x, z)) return false;
  // US-1 and its verge, wherever the highway runs along this key as a road (depth.ts US1_RUNS)
  if (Math.abs(z - chainZ(x)) < US1_HALF + ROAD_VERGE && onUS1Fill(x, chainZ(x))) return false;
  const [lx, lz] = islandLocal(I, x, z);
  if (onCourse(I, lx, lz)) return false;
  for (const r of marinaRects) if (rectDist(r, x, z) < GAP + 6) return false;
  return true;
}

/* ---------------------------------------------------------------- polygon helpers */

function polyArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a / 2;
}
function polyCentroid(poly) {
  let a = 0, x = 0, z = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    a += f; x += (poly[j][0] + poly[i][0]) * f; z += (poly[j][1] + poly[i][1]) * f;
  }
  return [x / (3 * a), z / (3 * a)];
}
function pointInPoly(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function polyDist(poly, x, z) {
  if (pointInPoly(poly, x, z)) return 0;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0], az = poly[j][1], dx = poly[i][0] - ax, dz = poly[i][1] - az, L = dx * dx + dz * dz;
    const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
  const t = L > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L)) : 0;
  return Math.hypot(a[0] + dx * t - p[0], a[1] + dz * t - p[1]);
}
function dp(pts, tol) {
  if (pts.length < 3) return pts;
  let idx = -1, md = 0;
  for (let i = 1; i < pts.length - 1; i++) { const d = segDist(pts[i], pts[0], pts[pts.length - 1]); if (d > md) { md = d; idx = i; } }
  if (md <= tol) return [pts[0], pts[pts.length - 1]];
  return [...dp(pts.slice(0, idx + 1), tol).slice(0, -1), ...dp(pts.slice(idx), tol)];
}
/** Closed-ring Douglas-Peucker: split at the vertex farthest from vertex 0. */
function simplifyRing(ring, tol) {
  let far = 0, fd = -1;
  for (let i = 0; i < ring.length; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = dp(ring.slice(0, far + 1), tol), b = dp([...ring.slice(far), ring[0]], tol);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/* ---------------------------------------------------------------- one island */

const N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function cutIsland(I, lots) {
  const priv = lots.some((l) => l.tier === 'private');
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const l of lots) for (const [x, z] of l.poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const grow = priv ? 200 : SHORE_REACH + CELL;
  x0 = Math.floor((x0 - grow) / CELL) * CELL; z0 = Math.floor((z0 - grow) / CELL) * CELL;
  const nx = Math.ceil((x1 + grow - x0) / CELL), nz = Math.ceil((z1 + grow - z0) / CELL);
  const cx = (i) => x0 + (i + 0.5) * CELL, cz = (k) => z0 + (k + 0.5) * CELL;
  const owner = new Int32Array(nx * nz).fill(-1);
  const boxes = lots.map((l) => {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [x, z] of l.poly) { a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, z); d = Math.max(d, z); }
    const g = SHORE_REACH + SPINE;
    return [a - g, b + g, c - g, d + g];
  });
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
    const x = cx(i), z = cz(k);
    if (!buildable(I, x, z)) continue;
    if (priv) { owner[k * nx + i] = 0; continue; }
    let best = -1, bd = Infinity;
    const sideBest = new Map();
    for (let j = 0; j < lots.length; j++) {
      const b = boxes[j];
      if (x < b[0] || x > b[1] || z < b[2] || z > b[3]) continue;
      const d = polyDist(lots[j].poly, x, z);
      if (d < bd) { bd = d; best = j; }
      const s = lots[j].side;
      if (!(sideBest.get(s) <= d)) sideBest.set(s, d);
    }
    // past REACH only on the way out to the water: seed → cell → shore within SHORE_REACH
    if (best < 0 || (bd > REACH && bd - islandDist(I, x, z) > SHORE_REACH)) continue;
    if (bd > 0) {
      // between a Bayside and an Oceanside lot: the seed plat's spine, left unsold
      const mine = lots[best].side;
      let other = Infinity;
      for (const [s, d] of sideBest) if (s !== mine && s !== 'Point') other = Math.min(other, d);
      if (other - bd < SPINE) continue;
    }
    owner[k * nx + i] = best;
  }

  return lots.map((lot, j) => {
    // largest 4-connected piece
    const seen = new Uint8Array(nx * nz);
    let bestComp = null;
    for (let s = 0; s < nx * nz; s++) {
      if (owner[s] !== j || seen[s]) continue;
      const comp = [s]; seen[s] = 1;
      for (let q = 0; q < comp.length; q++) {
        const c = comp[q], i = c % nx, k = (c / nx) | 0;
        for (const [di, dk] of N4) {
          const ii = i + di, kk = k + dk;
          if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
          const n = kk * nx + ii;
          if (!seen[n] && owner[n] === j) { seen[n] = 1; comp.push(n); }
        }
      }
      if (!bestComp || comp.length > bestComp.length) bestComp = comp;
    }
    if (!bestComp) return { lot, cells: 0 };
    const mask = new Uint8Array(nx * nz);
    for (const c of bestComp) mask[c] = 1;
    // fill holes: whatever the outside can't reach (4-connected) is inside the lot
    const out = new Uint8Array(nx * nz), stack = [];
    for (let i = 0; i < nx; i++) for (const k of [0, nz - 1]) stack.push(k * nx + i);
    for (let k = 0; k < nz; k++) for (const i of [0, nx - 1]) stack.push(k * nx + i);
    while (stack.length) {
      const c = stack.pop();
      if (out[c] || mask[c]) continue;
      out[c] = 1;
      const i = c % nx, k = (c / nx) | 0;
      for (const [di, dk] of N4) { const ii = i + di, kk = k + dk; if (ii >= 0 && kk >= 0 && ii < nx && kk < nz) stack.push(kk * nx + ii); }
    }
    let swallowed = 0;
    for (let c = 0; c < nx * nz; c++) if (!mask[c] && !out[c]) { if (owner[c] >= 0 && owner[c] !== j) swallowed++; mask[c] = 2; }
    if (swallowed) throw new Error(`${lot.id} would enclose ${swallowed} cells of another lot`);

    // trace: directed cell edges with the lot on the left, chained into the one ring
    const inM = (i, k) => i >= 0 && k >= 0 && i < nx && k < nz && mask[k * nx + i] > 0;
    const next = new Map();
    const key = (i, k) => k * (nx + 1) + i;
    const add = (a, b) => { if (next.has(key(...a))) throw new Error(`${lot.id}: pinch at ${a}`); next.set(key(...a), b); };
    let frontEdges = 0;
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      if (!inM(i, k)) continue;
      // counter-clockwise in (x, z): bottom, right, top, left
      if (!inM(i, k - 1)) add([i, k], [i + 1, k]);
      if (!inM(i + 1, k)) add([i + 1, k], [i + 1, k + 1]);
      if (!inM(i, k + 1)) add([i + 1, k + 1], [i, k + 1]);
      if (!inM(i - 1, k)) add([i, k + 1], [i, k]);
      for (const [di, dk] of N4) {
        if (inM(i + di, k + dk)) continue;
        if (landH(cx(i + di), cz(k + dk)) <= DRY) frontEdges++;
      }
    }
    const [startKey, startV] = next.entries().next().value;
    const ring = [];
    let v = [startKey % (nx + 1), Math.floor(startKey / (nx + 1))];
    for (let guard = 0; guard <= next.size; guard++) {
      ring.push([x0 + v[0] * CELL, z0 + v[1] * CELL]);
      v = next.get(key(...v));
      if (key(...v) === startKey) break;
    }
    if (ring.length !== next.size) throw new Error(`${lot.id}: outline has ${next.size - ring.length} stray edges`);
    void startV;
    const poly = simplifyRing(ring, SIMPLIFY).map(([x, z]) => [r1(x), r1(z)]);

    // label point: the area centroid if it is well inside, else the cell farthest from the edge
    const dist = new Float32Array(nx * nz).fill(0);
    const q = [];
    for (const c of bestComp) {
      const i = c % nx, k = (c / nx) | 0;
      if (N4.some(([di, dk]) => !inM(i + di, k + dk) || mask[(k + dk) * nx + i + di] !== 1)) { dist[c] = 1; q.push(c); }
    }
    for (let h = 0; h < q.length; h++) {
      const c = q[h], i = c % nx, k = (c / nx) | 0;
      for (const [di, dk] of N4) {
        const n = (k + dk) * nx + i + di;
        if (inM(i + di, k + dk) && mask[n] === 1 && !dist[n]) { dist[n] = dist[c] + 1; q.push(n); }
      }
    }
    let ax = 0, az = 0;
    for (const c of bestComp) { ax += cx(c % nx); az += cz((c / nx) | 0); }
    ax /= bestComp.length; az /= bestComp.length;
    const need = Math.ceil(CLEAR / CELL);
    const ci = Math.floor((ax - x0) / CELL), ck = Math.floor((az - z0) / CELL);
    let deepest = 0;
    for (const c of bestComp) deepest = Math.max(deepest, dist[c]);
    let label = null;
    if (inM(ci, ck) && mask[ck * nx + ci] === 1 && dist[ck * nx + ci] >= need) label = [ax, az];
    else {
      let bs = -Infinity;
      for (const c of bestComp) {
        const x = cx(c % nx), z = cz((c / nx) | 0);
        const s = Math.min(dist[c], need + 2) * 1000 - Math.hypot(x - ax, z - az);
        if (s > bs) { bs = s; label = [x, z]; }
      }
    }
    return {
      lot, cells: bestComp.length, poly, label, thin: deepest < need,
      frontage: Math.round(frontEdges * CELL * Math.PI / 4),
    };
  });
}

/* ---------------------------------------------------------------- the plat */

const byIsland = new Map();
for (const s of seeds) {
  const I = islandFor(s);
  if (!byIsland.has(I)) byIsland.set(I, []);
  byIsland.get(I).push(s);
}
const result = new Map();
for (const [I, lots] of byIsland) {
  const t = Date.now();
  for (const r of cutIsland(I, lots)) result.set(r.lot.id, r);
  console.error(`${I.name}: ${lots.length} lots, ${Date.now() - t} ms`);
}

const dropped = [];
const rows = [];
const q = (s) => JSON.stringify(s);
const fmt = (poly) => '[' + poly.map(([x, z]) => `[${x},${z}]`).join(',') + ']';
for (const s of seeds) {
  const r = result.get(s.id);
  const area = r.cells * CELL * CELL;
  const min = s.tier === 'private' ? MIN_PRIVATE : MIN_AREA;
  if (!r.cells || area < min || r.thin) { dropped.push(`${s.id} (${area} m²${r.thin ? ', no room for a house' : ''})`); continue; }
  // the label point must find this lot and no other
  if (!pointInPoly(r.poly, r.label[0], r.label[1])) throw new Error(`${s.id}: label point outside its outline`);
  rows.push(`  { id: ${q(s.id)}, name: ${q(s.name)}, island: ${q(s.island)}, tier: '${s.tier}', side: ${q(s.side)}, cx: ${r1(r.label[0])}, cz: ${r1(r.label[1])}, area: ${area}, frontage: ${r.frontage},\n    poly: ${fmt(r.poly)} },`);
}

// Harbor Row: four lots on the town pad behind the casino, in town.ts's own frame (u along the
// waterfront, v inland), so they move with the pad.
const HARBOR = [
  ['harbor-row-1', 'Harbor Row West 1', -102, -62],
  ['harbor-row-2', 'Harbor Row West 2', -60, -27],
  ['harbor-row-3', 'Harbor Row East 1', 27, 60],
  ['harbor-row-4', 'Harbor Row East 2', 62, 102],
];
const HV0 = 128, HV1 = 170;
for (const [id, name, u0, u1] of HARBOR) {
  const poly = [[u0, HV1], [u1, HV1], [u1, HV0], [u0, HV0]].map(([u, v]) => toWorld(TOWN_FRAME, u, v).map(r1));
  if (polyArea(poly) < 0) poly.reverse();
  const [x, z] = toWorld(TOWN_FRAME, (u0 + u1) / 2, (HV0 + HV1) / 2);
  rows.push(`  { id: ${q(id)}, name: ${q(name)}, island: "Marathon (Vaca Key)", tier: 'harbor', side: "Town", cx: ${r1(x)}, cz: ${r1(z)}, area: ${(u1 - u0) * (HV1 - HV0)}, frontage: ${u1 - u0}, walkable: true,\n    poly: ${fmt(poly)} },`);
}

const header = `/**
 * The Keys Run Estates plat: every parcel of buildable shore, as approved for review in the
 * "Keys Run Estates" land-registry page. GENERATED DATA, do not hand-edit a coordinate.
 *
 * Cut by scripts/estates/plat.mjs over this package's own world (\`islands\`' real outlines, \`landH\`,
 * \`creekDist\`, \`onCourse\`, the golf/airfield fill, \`MARINAS\`, \`inTownFootprint\`), starting from the
 * lots first approved (scripts/estates/seed-plat.json): each lot is the dry land (landH > ${DRY})
 * nearest its seed on the same island, ${GAP} m short of creeks, the town pad, the golf courses, the
 * airfield and all four marinas, traced on a ${CELL} m raster and simplified to ${SIMPLIFY} m, so edges stop
 * at the dry-land line and follow the canals. Areas are m² of dry game ground; frontage is metres
 * of edge on the water; (cx, cz) is the lot's centroid, or its most inland spot when the centroid
 * falls off the lot. Ids come from the seed plat, never from geometry, and are the database keys
 * (apps/api \`estates.parcel_id\`). test/estates.test.ts re-checks the plat against the live world,
 * so a terrain change that strands a lot fails a test instead of a buyer.
 *
 * Re-run after any change to the world's shape (from the repo root):
 *   pnpm --filter @keysrun/shared build && node scripts/estates/plat.mjs
${dropped.length ? ` *\n * Seed lots with no room left on the real shore (not in this plat): ${dropped.map((d) => d.split(' ')[0]).join(', ')}.\n` : ''} */
import type { Parcel } from './estates.js';

export const PARCELS: readonly Parcel[] = [
${rows.join('\n')}
];
`;
writeFileSync(OUT, header);
console.log(`${rows.length} parcels written to ${OUT}`);
console.log(`dropped ${dropped.length}: ${dropped.join(', ') || 'none'}`);
