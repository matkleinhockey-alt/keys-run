/**
 * Single chunk mesh: a `segs`x`segs` grid of real bathymetry (`seafloorHeightAt`) over one
 * CHUNK_SIZE (64 m) tile, vertex-coloured by depth band (./heightfield.ts), plus a short skirt
 * dropped around its perimeter. Neighbouring chunks can legitimately be at different LOD levels
 * (different `segs` — see ./lod.ts's header for why), which would otherwise leave a see-through
 * crack where their edges don't line up; the skirt hides that the simple, standard way instead of
 * stitching matching edge topology between neighbours.
 *
 * Positions are baked in absolute world space (not chunk-local, translated by a mesh transform)
 * so the mesh itself can stay at identity with `matrixAutoUpdate = false` — see ./lod.ts.
 */
import * as THREE from 'three';
import { WORLD } from '@keysrun/shared/world/depth';
import { CHUNK_SIZE, seafloorHeightAt, seafloorColorAt } from './heightfield.js';

const SKIRT_DEPTH = 3; // metres the perimeter drops — comfortably more than any LOD seam's gap

/**
 * Builds one chunk's geometry. `segs` is the number of quads per side (segs+1 vertices per
 * side); higher = finer LOD. Callers own the (shared) material — this only produces geometry.
 */
export function buildChunkGeometry(cx: number, cz: number, segs: number): THREE.BufferGeometry {
  const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
  const n = Math.max(1, segs | 0);
  const rows = n + 1;
  const step = CHUNK_SIZE / n;

  // Pass 1: sample height once per grid vertex; reused below both for position and for
  // neighbour-difference slope shading (no extra depthFast calls needed for that).
  const h = new Float32Array(rows * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < rows; i++) {
      h[j * rows + i] = seafloorHeightAt(x0 + i * step, z0 + j * step);
    }
  }

  const topCount = rows * rows;
  const perimeterLen = 4 * n; // walking the border of an (n+1)x(n+1) grid visits 4*n distinct verts
  const vertCount = topCount + perimeterLen * 2; // skirt: a (top, bottom) pair per perimeter vert
  const pos = new Float32Array(vertCount * 3);
  const col = new Float32Array(vertCount * 3);
  const uv = new Float32Array(vertCount * 2);

  const colorAtGrid = (i: number, j: number): [number, number, number] => {
    const x = x0 + i * step, z = z0 + j * step;
    const y = h[j * rows + i], d = -y;
    const iL = Math.max(0, i - 1), iR = Math.min(n, i + 1), jD = Math.max(0, j - 1), jU = Math.min(n, j + 1);
    const slope = (Math.abs(h[j * rows + iR] - h[j * rows + iL]) / ((iR - iL) * step || 1)
      + Math.abs(h[jU * rows + i] - h[jD * rows + i]) / ((jU - jD) * step || 1)) * 0.5;
    const shade = 1 - Math.min(0.35, slope * 1.4);
    return seafloorColorAt(x, z, d, shade);
  };

  let vi = 0;
  const putVert = (x: number, y: number, z: number, c: readonly [number, number, number]): void => {
    pos[vi * 3] = x; pos[vi * 3 + 1] = y; pos[vi * 3 + 2] = z;
    col[vi * 3] = c[0]; col[vi * 3 + 1] = c[1]; col[vi * 3 + 2] = c[2];
    // World-space UV (not 0..1 per chunk) so the shared grain/normal textures tile continuously
    // across chunk boundaries instead of visibly repeating every 64 m — matches legacy's single
    // big plane, whose default PlaneGeometry UV already spanned the whole world this way.
    uv[vi * 2] = (x - WORLD.x0) / WORLD.size; uv[vi * 2 + 1] = (z - WORLD.z0) / WORLD.size;
    vi++;
  };

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < rows; i++) {
      putVert(x0 + i * step, h[j * rows + i], z0 + j * step, colorAtGrid(i, j));
    }
  }

  const idx: number[] = [];
  const at = (i: number, j: number): number => j * rows + i;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d2 = at(i + 1, j + 1);
      // Winding chosen so the face normal (three.js derives it from screen-space derivatives
      // under flatShading, so this matters for which side the triangle is front-facing on) points
      // +Y — see the material's `side: THREE.DoubleSide` in ./lod.ts for why a mistake here (e.g.
      // on the skirt walls below) still renders rather than silently vanishing.
      idx.push(a, c, b, b, c, d2);
    }
  }

  // Skirt: walk the perimeter in order, emit a (top, bottom) vertex pair per boundary vertex, and
  // stitch consecutive pairs into a wall quad.
  const perimeter: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) perimeter.push([i, 0]);
  for (let j = 0; j < n; j++) perimeter.push([n, j]);
  for (let i = n; i > 0; i--) perimeter.push([i, n]);
  for (let j = n; j > 0; j--) perimeter.push([0, j]);

  const skirtStart = vi;
  for (const [i, j] of perimeter) {
    const x = x0 + i * step, z = z0 + j * step, y = h[j * rows + i];
    const c = colorAtGrid(i, j);
    putVert(x, y, z, c);
    putVert(x, y - SKIRT_DEPTH, z, c);
  }
  const pCount = perimeter.length;
  for (let k = 0; k < pCount; k++) {
    const k2 = (k + 1) % pCount;
    const aTop = skirtStart + k * 2, aBot = aTop + 1, bTop = skirtStart + k2 * 2, bBot = bTop + 1;
    idx.push(aTop, aBot, bTop, bTop, aBot, bBot);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}
