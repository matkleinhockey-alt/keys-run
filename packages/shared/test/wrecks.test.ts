/**
 * Where the shipwrecks end up (world/wrecks.ts), and what the 'Wreck' rod table promises.
 *
 * Same idea as client test/party-boats.test.ts and race.test.ts: placement is *found* from the real
 * bathymetry, so what is asserted here is the actual result against the real `depthAt`/`landH`/
 * `shoreInfo`, not the intent - a hand-typed coordinate is one terrain tweak from a freighter in a
 * mangrove, and this project has had that bug.
 */
import { describe, expect, it } from 'vitest';
import { depthAt, landH, zoneAt } from '../src/world/depth.js';
import { chainZ, shoreInfo } from '../src/world/chain.js';
import { MARATHON_COURSE, buoyPos } from '../src/sim/race.js';
import { xoshiro128ss } from '../src/rng/index.js';
import { ZONE_TABLE, SPECIES } from '../src/content/species.js';
import { VIS, isCatchable } from '../src/content/creatures.js';
import { chooseFish, wreckSizeT } from '../src/sim/fight.js';
import {
  wrecksFor, WRECK_SPECS, CLEARANCE_M, holdPoints, wreckPoint, wreckEdgeDist, wreckNear, WRECK_CAST_M, WRECK_RESIDENTS,
} from '../src/world/wrecks.js';

const SEED = 20240817;
const wrecks = wrecksFor(SEED);

/** Footprint ring: both ends and both sides of the hull, widened by half a beam. */
function ring(w: (typeof wrecks)[number]): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (const u of [-0.5, 0, 0.5]) for (const v of [-0.6, 0, 0.6]) { const p = wreckPoint(w, u, v); pts.push([p.x, p.z]); }
  return pts;
}

describe('placement', () => {
  it('finds every wreck (a spec that finds no site is a silent loss)', () => {
    expect(wrecks.map((w) => w.id)).toEqual(WRECK_SPECS.map((s) => s.id));
  });

  it('is a handful, not scenery on every reef', () => {
    expect(wrecks.length).toBeGreaterThanOrEqual(4);
    expect(wrecks.length).toBeLessThanOrEqual(8);
  });

  it('puts every hull in open water: not on land, not in an island, well off every shore', () => {
    for (const w of wrecks) {
      expect(landH(w.x, w.z), `${w.id} on land`).toBeLessThanOrEqual(-0.3);
      expect(shoreInfo(w.x, w.z).d, `${w.id} too close to shore`).toBeGreaterThanOrEqual(300);
      for (const [x, z] of ring(w)) {
        expect(landH(x, z), `${w.id} footprint on land`).toBeLessThanOrEqual(-0.3);
        expect(shoreInfo(x, z).d, `${w.id} footprint near shore`).toBeGreaterThan(150);
      }
    }
  });

  it('is never on a flat or in a creek or channel zone', () => {
    for (const w of wrecks) expect(['Hawk Channel', 'Reef', 'Offshore'], `${w.id} zone`).toContain(zoneAt(w.x, w.z));
  });

  it('sits in the depth band its spec asks for, with the hull top under a boat-safe clearance', () => {
    for (const w of wrecks) {
      const d = depthAt(w.x, w.z);
      expect(d, `${w.id} depth`).toBeGreaterThanOrEqual(w.depth[0]);
      expect(d, `${w.id} depth`).toBeLessThanOrEqual(w.depth[1]);
      expect(d, `${w.id} would break the surface`).toBeGreaterThanOrEqual(w.height + CLEARANCE_M);
      for (const [x, z] of ring(w)) expect(depthAt(x, z), `${w.id} shallow corner`).toBeGreaterThan(w.height + CLEARANCE_M * 0.5 - 0.01);
    }
  });

  it('lies on a seabed flat enough to hold a hull', () => {
    for (const w of wrecks) {
      const ds = ring(w).map(([x, z]) => depthAt(x, z));
      expect(Math.max(...ds) - Math.min(...ds), `${w.id} relief`).toBeLessThanOrEqual(w.maxRelief + 1.5);
    }
  });

  it('can be dived and speared on at least some of them, and not all of them are diveable', () => {
    const diveable = wrecks.filter((w) => w.seaDepth <= 25);
    expect(diveable.length).toBeGreaterThanOrEqual(3);
    expect(wrecks.some((w) => w.seaDepth > 40)).toBe(true);
    // ...across more than one depth band, so there is a reason to come back with more breath
    expect(new Set(wrecks.map((w) => Math.floor(w.seaDepth / 10))).size).toBeGreaterThanOrEqual(3);
  });

  it('keeps wrecks apart and away from the race buoys', () => {
    for (let i = 0; i < wrecks.length; i++) {
      for (let j = i + 1; j < wrecks.length; j++) {
        expect(Math.hypot(wrecks[i].x - wrecks[j].x, wrecks[i].z - wrecks[j].z), `${wrecks[i].id}/${wrecks[j].id}`).toBeGreaterThan(600);
      }
      for (const b of MARATHON_COURSE) {
        const p = buoyPos(b);
        expect(Math.hypot(wrecks[i].x - p.x, wrecks[i].z - p.z), `${wrecks[i].id} vs buoy ${b.name}`).toBeGreaterThan(200);
      }
    }
  });

  it('is found quickly (the search is a few attempts, not a prayer)', () => {
    for (const w of wrecks) expect(w.attempt, w.id).toBeLessThan(500);
  });

  it('settles along the contour, with a pitch that follows the seabed', () => {
    for (const w of wrecks) {
      // heading axis vs gradient: the depth change along the hull is much smaller than across it
      const f = [-Math.sin(w.heading), -Math.cos(w.heading)];
      const along = Math.abs(depthAt(w.x + f[0] * 20, w.z + f[1] * 20) - depthAt(w.x - f[0] * 20, w.z - f[1] * 20));
      const across = Math.abs(depthAt(w.x - f[1] * 20, w.z + f[0] * 20) - depthAt(w.x + f[1] * 20, w.z - f[0] * 20));
      expect(along, `${w.id} lies down the slope`).toBeLessThanOrEqual(across + 1.5);
      expect(Math.abs(w.pitch)).toBeLessThan(0.35);
    }
  });
});

describe('determinism', () => {
  it('is a pure function of the seed, and does not depend on call order', () => {
    const a = wrecksFor(SEED).map((w) => [w.id, w.x, w.z, w.heading]);
    wrecksFor(1); wrecksFor(2);
    expect(wrecksFor(SEED).map((w) => [w.id, w.x, w.z, w.heading])).toEqual(a);
  });

  it('each wreck depends only on its own spec index, so editing another cannot move it', () => {
    // Positions come from hashCell(seed, specIndex, attempt, salt): nothing a neighbour does is an input.
    const third = wrecks[2];
    expect(third.index).toBe(2);
    expect(wrecksFor(SEED)[2]).toBe(third);
  });

  it('stays valid on other worlds: the placement rules, not the seed, are what guarantee it', () => {
    for (const seed of [1, 7, 99, 424242, 20240818]) {
      const ws = wrecksFor(seed);
      expect(ws.length, `seed ${seed}`).toBe(WRECK_SPECS.length);
      for (const w of ws) {
        expect(landH(w.x, w.z)).toBeLessThanOrEqual(-0.3);
        expect(depthAt(w.x, w.z)).toBeGreaterThanOrEqual(w.height + CLEARANCE_M);
        expect(shoreInfo(w.x, w.z).d).toBeGreaterThanOrEqual(300);
      }
    }
  });
});

describe('what a cast and a diver find', () => {
  it('captures a cast on the hull and not far away', () => {
    for (const w of wrecks) {
      expect(wreckNear(SEED, w.x, w.z)?.id).toBe(w.id);
      const edge = wreckPoint(w, 0.45).x;
      expect(wreckEdgeDist(w, edge, wreckPoint(w, 0.45).z)).toBeLessThan(WRECK_CAST_M);
      expect(wreckNear(SEED, w.x + 200, w.z)).toBeNull();
    }
  });

  it('every hold point is in water, under the surface, above the seabed, and near the hull', () => {
    for (const w of wrecks) {
      const pts = holdPoints(w);
      expect(pts.length, w.id).toBeGreaterThanOrEqual(3);
      for (const p of pts) {
        expect(landH(p.x, p.z), `${w.id} ${p.label}`).toBeLessThanOrEqual(-0.3);
        expect(p.h + p.hr, `${w.id} ${p.label} breaks the surface`).toBeLessThan(depthAt(p.x, p.z) - 0.5);
        expect(p.h, `${w.id} ${p.label} on the bottom`).toBeGreaterThan(1);
        expect(wreckEdgeDist(w, p.x, p.z), `${w.id} ${p.label} off the wreck`).toBeLessThan(w.beam + 6);
      }
    }
  });

  it('bigger wrecks hold more', () => {
    const by = Object.fromEntries(wrecks.map((w) => [w.id, holdPoints(w).length]));
    expect(by.freighterC).toBeGreaterThan(by.dc3);
    expect(by.freighterB).toBeGreaterThan(by.tug);
  });
});

describe("the 'Wreck' rod table", () => {
  const tbl = ZONE_TABLE.Wreck;
  it('exists and is all catchable structure-holders', () => {
    expect(tbl.length).toBeGreaterThan(6);
    for (const [k] of tbl) { expect(SPECIES[k], k).toBeDefined(); expect(isCatchable(k), k).toBe(true); }
    const keys = tbl.map(([k]) => k);
    for (const want of ['amberjack', 'cobia', 'grouper', 'barracuda', 'jackcrevalle']) expect(keys).toContain(want);
  });

  it('leans to big fish: its weight-averaged species ceiling beats the Reef and Oil Rig tables', () => {
    const maxAvg = (t: Array<[string, number]>): number => t.reduce((a, [k, w]) => a + SPECIES[k].max * w, 0) / t.reduce((a, [, w]) => a + w, 0);
    expect(maxAvg(tbl)).toBeGreaterThan(maxAvg(ZONE_TABLE.Reef) * 2);
    expect(maxAvg(tbl)).toBeGreaterThan(maxAvg(ZONE_TABLE['Oil Rig']) * 0.9);
  });

  it('rolls heavy: the median wreck fish sits well up its species range, a reef cast does not', () => {
    const rng = xoshiro128ss(777);
    const bob = { x: wrecks[3].x, z: wrecks[3].z };
    const fr: number[] = [], rf: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const a = chooseFish('Wreck', bob, { hotspot: true, hump: null }, rng);
      fr.push((a.weight - SPECIES[a.key].min) / (SPECIES[a.key].max - SPECIES[a.key].min));
      const b = chooseFish('Reef', bob, { hotspot: true, hump: null }, rng);
      rf.push((b.weight - SPECIES[b.key].min) / (SPECIES[b.key].max - SPECIES[b.key].min));
    }
    const med = (a: number[]): number => [...a].sort((x, y) => x - y)[a.length >> 1];
    expect(med(fr)).toBeGreaterThan(0.55);
    expect(med(fr) - med(rf)).toBeGreaterThan(0.2);
    expect(Math.min(...fr)).toBeGreaterThanOrEqual(0.24);
  });

  it('wreckSizeT is bounded, floored and has a trophy tail', () => {
    expect(wreckSizeT(0, 1, 0)).toBeCloseTo(0.25, 5);
    expect(wreckSizeT(1, 1, 1)).toBeLessThanOrEqual(1);
    expect(wreckSizeT(0, 0, 1)).toBeGreaterThanOrEqual(0.8);
  });

  it('what a diver sees is drawn from the same distribution: residents are real, catchable species', () => {
    for (const [k] of WRECK_RESIDENTS) { expect(VIS[k], k).toBeDefined(); expect(isCatchable(k)).toBe(true); expect(SPECIES[k], k).toBeDefined(); }
    // and the rod table and the residents agree on which species the wreck is about
    const rod = new Set(tbl.map(([k]) => k));
    const shared = WRECK_RESIDENTS.filter(([k]) => rod.has(k)).length;
    expect(shared).toBeGreaterThanOrEqual(WRECK_RESIDENTS.length - 1);
  });
});

describe('sanity of the search window', () => {
  it('the chain offset it searches is the one depthAt uses', () => {
    const w = wrecks[2];
    expect(w.z - chainZ(w.x)).toBeGreaterThan(w.dzRange[0] - 1);
    expect(w.z - chainZ(w.x)).toBeLessThan(w.dzRange[1] + 1);
  });
});
