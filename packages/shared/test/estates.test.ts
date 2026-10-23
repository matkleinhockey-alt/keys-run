import { describe, expect, it } from 'vitest';
import {
  FOUNDING_HOLDERS, PARCELS, TIER_ORDER, defaultBuild, estateBerth, estateGround, parcelAt, parcelById,
  partyLot, priceOf, sanitizeBuild, siteLayout, type Build,
} from '../src/content/estates.js';
import { SPECIES } from '../src/content/species.js';
import { landH } from '../src/world/depth.js';
import { COLLIDERS, groundAt } from '../src/world/town.js';

const ALL_DOCKS: Build['dock'][] = ['none', 'skiff', 'sport', 'yacht'];
const ALL_RES: Build['res'][] = ['villa', 'shack', 'garden', 'stilt', 'glass'];

describe('the plat', () => {
  it('has unique ids, every tier, and every founding lot', () => {
    expect(new Set(PARCELS.map((p) => p.id)).size).toBe(PARCELS.length);
    for (const t of TIER_ORDER) expect(PARCELS.some((p) => p.tier === t)).toBe(true);
    for (const id of Object.keys(FOUNDING_HOLDERS)) expect(parcelById(id)).toBeDefined();
  });

  it('finds each lot from its own centroid, and nothing out at sea', () => {
    for (const p of PARCELS) expect(parcelAt(p.cx, p.cz)?.id).toBe(p.id);
    expect(parcelAt(0, 3000)).toBeNull();
  });

  it('prices by tier and area, in $500 steps', () => {
    for (const p of PARCELS) { expect(priceOf(p) % 500).toBe(0); expect(priceOf(p)).toBeGreaterThan(0); }
    const ocean = PARCELS.filter((p) => p.tier === 'oceanfront').sort((a, b) => a.area - b.area);
    expect(priceOf(ocean[ocean.length - 1])).toBeGreaterThan(priceOf(ocean[0]));
  });

  it('puts Harbor Row on the town pad and clear of every building', () => {
    for (const p of PARCELS.filter((q) => q.tier === 'harbor')) {
      for (const [x, z] of p.poly) expect(groundAt(x, z)).not.toBeNull();
      const L = siteLayout(p, defaultBuild(p));
      const h = L.house;
      for (const c of COLLIDERS) {
        const hit = h.x + h.w / 2 > c.x0 && h.x - h.w / 2 < c.x1 && h.z + h.d / 2 > c.z0 && h.z - h.d / 2 < c.z1;
        expect(hit, `${p.id} house overlaps a town collider`).toBe(false);
      }
    }
  });
});

describe('site layout against the live world', () => {
  it('stands every house on dry lot ground and runs every dock out into water', () => {
    for (const p of PARCELS) {
      if (p.tier === 'harbor') continue;
      for (const res of ALL_RES) for (const dock of ALL_DOCKS) {
        const L = siteLayout(p, { ...defaultBuild(p), res, dock });
        expect(estateGround(p, L, L.house.x, L.house.z), `${p.id} ${res}`).not.toBeNull();
        if (dock === 'none') { expect(L.dock).toBeNull(); continue; }
        expect(L.dock).not.toBeNull();
        expect(landH(L.dock!.x1, L.dock!.z1), `${p.id} ${dock} ends on land`).toBeLessThanOrEqual(0);
      }
    }
  });

  it('can be walked from the house down the dock to the berth, with no step taller than a stair', () => {
    for (const p of PARCELS) {
      if (p.tier === 'harbor') continue;
      const L = siteLayout(p, { ...defaultBuild(p), dock: 'sport' });
      const d = L.dock!;
      let prev: number | null = null;
      for (let t = 0; t <= d.len; t += 0.5) {
        const g = estateGround(p, L, d.x0 + L.sea[0] * t, d.z0 + L.sea[1] * t);
        expect(g, `${p.id} gap on the dock at ${t} m`).not.toBeNull();
        if (prev !== null) expect(Math.abs(g! - prev)).toBeLessThan(0.7);
        prev = g;
      }
      const b = estateBerth(L)!;
      expect(estateGround(p, L, b.x, b.z)).toBeCloseTo(1.425);
    }
  });

  it('places as many trophies as asked, on the lot', () => {
    const p = parcelById('pigeon-key')!;
    const L = siteLayout(p, { ...defaultBuild(p), trophies: 10 });
    expect(L.trophies.length).toBe(10);
    for (const t of L.trophies) expect(estateGround(p, L, t.x, t.z)).not.toBeNull();
  });
});

describe('builds', () => {
  it('cleans junk back to a valid build', () => {
    const p = parcelById('fisher-island')!;
    const b = sanitizeBuild({ res: 'castle', dock: 'yacht', fish: 'kraken', lb: 1e9, trophies: 99, pool: 'yes', mount: 'gallows' }, p);
    expect(b.res).toBe(defaultBuild(p).res);
    expect(b.dock).toBe('yacht');
    expect(b.fish).toBe(defaultBuild(p).fish);
    expect(b.lb).toBe(SPECIES[b.fish].max);
    expect(b.trophies).toBe(10);
    expect(typeof b.pool).toBe('boolean');
  });

  it('never gives Harbor Row a dock, or a gallows with nothing to hang from', () => {
    const p = parcelById('harbor-row-2')!;
    const b = sanitizeBuild({ dock: 'yacht', mount: 'gallows' }, p);
    expect(b.dock).toBe('none');
    expect(b.mount).toBe('door');
  });
});

describe('the party', () => {
  it('goes to the #1 angler\'s most valuable lot', () => {
    expect(partyLot(['harbor-row-4', 'fisher-island'])?.id).toBe('fisher-island');
    expect(partyLot([])).toBeNull();
  });
});

describe('tying up at an estate dock', () => {
  it('berths a boat lying alongside, on the planks, and refuses one out of reach', async () => {
    const { estateDockBerth } = await import('../src/content/estates.js');
    const p = parcelById('pigeon-key')!;
    const L = siteLayout(p, defaultBuild(p));
    const d = L.dock!;
    const [sx, sz] = L.sea;
    // 4 m off the side of the dock, two-thirds of the way out
    const t = d.len * 0.66, bx = d.x0 + sx * t - sz * (d.w / 2 + 4), bz = d.z0 + sz * t + sx * (d.w / 2 + 4);
    const b = estateDockBerth(L, bx, bz, 9)!;
    expect(b).not.toBeNull();
    expect(b.dist).toBeCloseTo(4, 1);
    expect(estateGround(p, L, b.x, b.z)).toBeCloseTo(1.425);
    expect(estateDockBerth(L, bx - sz * 30, bz + sx * 30, 9)).toBeNull();
  });
});
