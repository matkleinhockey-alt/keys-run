/**
 * Shared "walk/drive a loop" utility: a closed polyline with cumulative arc length, a
 * position+tangent sampler at an arbitrary arc-length offset, and a nearest-point query.
 *
 * Legacy duplicated this exact shape three times with cosmetic renames: `makePath`/`pathAt`
 * (index.html:3263-3266, the deck party's walking loop), `makeRoute`/`routeAt`/`closestS`
 * (index.html:1741-1751, go-fast racers), and `routeFrom` (index.html:1805, ambient traffic —
 * same as `makeRoute` but built from explicit waypoints instead of a `chainZ`-offset sweep, and
 * filtered by a shallower depth). One generic implementation here, with the two legacy
 * constructors kept as thin named wrappers (`chainRoute`/`pointRoute`) so each caller still reads
 * like its own legacy function.
 */
import { depthAt } from '@keysrun/shared/world/depth';
import { chainZ } from '@keysrun/shared/world/chain';

export interface PathSample { x: number; z: number; tx: number; tz: number }

export interface Path {
  readonly pts: ReadonlyArray<readonly [number, number]>;
  readonly total: number;
  /** Position + unit tangent at arc-length `s` (wrapped into the loop). */
  at(s: number): PathSample;
  /** Arc-length of the path point nearest (x,z) — legacy `closestS`. */
  closestS(x: number, z: number): number;
}

export function createPath(pts: ReadonlyArray<readonly [number, number]>): Path {
  const cum: number[] = [0];
  for (let i = 1; i <= pts.length; i++) {
    const a = pts[i - 1], b = pts[i % pts.length];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = cum[pts.length] || 1;
  return {
    pts,
    total,
    at(sIn: number): PathSample {
      const s = ((sIn % total) + total) % total;
      let i = 0;
      while (i < pts.length - 1 && cum[i + 1] < s) i++;
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const seg = cum[i + 1] - cum[i] || 1;
      const u = (s - cum[i]) / seg;
      const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
      return { x: a[0] + dx * u, z: a[1] + dz * u, tx: dx / l, tz: dz / l };
    },
    closestS(x: number, z: number): number {
      let best = Infinity, s = 0;
      pts.forEach((p, i) => {
        const d = (p[0] - x) ** 2 + (p[1] - z) ** 2;
        if (d < best) { best = d; s = cum[i]; }
      });
      return s;
    },
  };
}

/**
 * legacy `makeRoute` (index.html:1741-1746): a there-and-back sweep of the whole chain at two
 * offsets from the island spine, filtered to water deep enough to run (>2.5 m) — used by
 * go-fast racers and most ambient traffic routes.
 */
export function chainRoute(dzOut: number, dzBack: number): Path {
  const pts: Array<[number, number]> = [];
  for (let x = 3900; x >= -3900; x -= 200) { const z = chainZ(x) + dzOut; if (depthAt(x, z) > 2.5) pts.push([x, z]); }
  for (let x = -3900; x <= 3900; x += 200) { const z = chainZ(x) + dzBack; if (depthAt(x, z) > 2.5) pts.push([x, z]); }
  return createPath(pts);
}

/** legacy `routeFrom` (index.html:1805): an explicit waypoint loop (harbor/bay/beach traffic),
 * filtered to water deep enough for a small boat (>1.6 m). */
export function pointRoute(pts: ReadonlyArray<readonly [number, number]>): Path {
  return createPath(pts.filter((p) => depthAt(p[0], p[1]) > 1.6));
}

/** Shortest-path angle interpolation (legacy's module-level `angLerp`), re-declared here per this
 * codebase's convention (core/math.ts's header) of every module keeping its own trivial copy
 * rather than this tiny utility living in a shared location. */
export function angLerp(a: number, b: number, t: number): number {
  const d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * t;
}
