/**
 * The client half of the shipwrecks: the fish that hold on them (entities/fish/spawn.ts), the
 * cast hook (game/fishing/spot.ts), the found-not-gifted chart (entities/life/wreck-chart.ts), and
 * that wrecks never land on the other placed things in the world. Placement itself is asserted
 * against the real bathymetry in packages/shared/test/wrecks.test.ts.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { wrecksFor, holdPoints, WRECK_RESIDENTS, WRECK_CHART_M, wreckPoint, type Wreck } from '@keysrun/shared/world/wrecks';
import { chainZ } from '@keysrun/shared/world/chain';
import { VIS } from '@keysrun/shared/content/creatures';
import { SPECIES } from '@keysrun/shared/content/species';
import { wreckSchoolsFor, instantiateWreckSchool } from '../src/entities/fish/spawn.js';
import { resolveCastSpot, NO_SPOTS } from '../src/game/fishing/spot.js';
import { findAnchorage, PARTY_ANCHORAGES } from '../src/entities/life/party-boats.js';
import { RIG_SITES } from '../src/entities/life/hotspots.js';
import { chartNear, chartedWrecks, isCharted, resetChart, setWrecksPrecharted, WRECKS_PRECHARTED } from '../src/entities/life/wreck-chart.js';
import { WORLD_SEED } from '../src/state/constants.js';

const wrecks = wrecksFor(WORLD_SEED);
const byId = (id: string): Wreck => wrecks.find((w) => w.id === id)!;

describe('does not collide with the other placed things', () => {
  it('is nowhere near an oil rig', () => {
    for (const w of wrecks) for (const [rx, rdz] of RIG_SITES) {
      expect(Math.hypot(w.x - rx, w.z - (chainZ(rx) + rdz)), `${w.id} vs rig`).toBeGreaterThan(1000);
    }
  });

  it('is nowhere near a party-boat anchorage', () => {
    for (const a of PARTY_ANCHORAGES) {
      const p = findAnchorage(a.x, a.dir, a.startDz);
      if (!p) continue;
      for (const w of wrecks) expect(Math.hypot(w.x - p.x, w.z - p.z), `${w.id} vs ${a.name}`).toBeGreaterThan(400);
    }
  });
});

describe('the cast hook', () => {
  it('a cast on a wreck overrides the zone to Wreck and sets the hotspot flag', () => {
    const q = { ...NO_SPOTS, nearWreck: () => ({ name: 'Harbor tug' }) };
    const r = resolveCastSpot(q, 0, 0, 'Reef');
    expect(r).toMatchObject({ zone: 'Wreck', kind: 'wreck', wreckName: 'Harbor tug' });
    expect(r.hs).not.toBeNull();
  });

  it('keeps a live frenzy strength when one overlaps, and loses to a rig', () => {
    const q = { ...NO_SPOTS, nearWreck: () => ({ name: 'x' }), nearHotspot: () => ({ fr: 0.6 }) };
    expect(resolveCastSpot(q, 0, 0, 'Reef').hs).toEqual({ fr: 0.6 });
    expect(resolveCastSpot({ ...q, nearRig: () => ({}) }, 0, 0, 'Offshore').zone).toBe('Oil Rig');
  });

  it('beats a weedline drifting over it', () => {
    const q = { ...NO_SPOTS, nearWreck: () => ({ name: 'x' }), nearWeed: () => ({}) };
    expect(resolveCastSpot(q, 0, 0, 'Offshore').zone).toBe('Wreck');
  });

  it('a query with no nearWreck at all still works (older harnesses)', () => {
    expect(resolveCastSpot({ nearHotspot: () => null, nearWeed: () => null, nearRig: () => null }, 0, 0, 'Reef').kind).toBeNull();
  });
});

describe('fish holding on the wrecks', () => {
  it('is deterministic: the same fish every time, for every client', () => {
    for (const w of wrecks) {
      const a = wreckSchoolsFor(WORLD_SEED, w, WRECK_RESIDENTS), b = wreckSchoolsFor(WORLD_SEED, w, WRECK_RESIDENTS);
      expect(b).toEqual(a);
    }
  });

  it('puts a school on every hold point it has a species for, anchored on the wreck', () => {
    for (const w of wrecks) {
      const specs = wreckSchoolsFor(WORLD_SEED, w, WRECK_RESIDENTS);
      expect(specs.length, w.id).toBeGreaterThanOrEqual(3);
      const pts = holdPoints(w);
      for (const s of specs) {
        expect(pts.some((p) => p.x === s.anchorX && p.z === s.anchorZ), `${w.id} school not on a hold point`).toBe(true);
        expect(s.hold, w.id).toBeDefined();
        const st = instantiateWreckSchool(s, w, 0);
        expect(st.anchor?.hold).toEqual(s.hold);
        expect(st.resident).toBe(true);
      }
    }
  });

  it('only species that can live at the wreck depth, and bottom-dwellers only beside the hull', () => {
    for (const w of wrecks) {
      const pts = holdPoints(w);
      for (const s of wreckSchoolsFor(WORLD_SEED, w, WRECK_RESIDENTS)) {
        const V = VIS[s.type];
        expect(w.seaDepth - 1, `${w.id} ${s.type} too shallow`).toBeGreaterThanOrEqual(V.dMin);
        expect(w.seaDepth, `${w.id} ${s.type} too deep`).toBeLessThanOrEqual(V.dMax);
        const label = pts.find((p) => p.x === s.anchorX && p.z === s.anchorZ)!.label;
        // a goliath on the axis would be inside the hull
        expect(V.level === 'bottom', `${w.id} ${s.type} at ${label}`).toBe(label === 'lee');
      }
    }
  });

  it('is the big ones: members sit in the top of their species range (what the rod promises)', () => {
    const fr: number[] = [];
    for (const w of wrecks) for (const s of wreckSchoolsFor(WORLD_SEED, w, WRECK_RESIDENTS)) for (const m of s.members) fr.push(m.sizeU);
    expect(fr.length).toBeGreaterThan(40);
    expect(Math.min(...fr)).toBeGreaterThanOrEqual(0.25 - 1e-9);
    const mean = fr.reduce((a, b) => a + b, 0) / fr.length;
    // a plain reef school's sizeU is uniform on [0,1] (mean 0.5); wreck fish run well above it
    expect(mean).toBeGreaterThan(0.62);
  });

  it('the biggest wreck holds fish you would call big: heavy, catchable, structure-holders', () => {
    const big = byId('freighterB');
    const all = wreckSchoolsFor(WORLD_SEED, big, WRECK_RESIDENTS).flatMap((s) => s.members.map((m) => ({ k: s.type, kg: SPECIES[s.type].min + (SPECIES[s.type].max - SPECIES[s.type].min) * m.sizeU })));
    expect(all.length).toBeGreaterThan(8);
    expect(all.some((f) => f.kg >= 60)).toBe(true);
    // no baitfish cloud: nothing under a pound
    expect(all.every((f) => f.kg >= 2)).toBe(true);
  });

  it('members are scaled by weight (the bigger fish is drawn bigger)', () => {
    const s = wreckSchoolsFor(WORLD_SEED, byId('freighterA'), WRECK_RESIDENTS).find((x) => x.members.length >= 3)!;
    const sorted = [...s.members].sort((a, b) => a.sizeU - b.sizeU);
    expect(sorted[sorted.length - 1].scale).toBeGreaterThanOrEqual(sorted[0].scale);
  });

  it('every hold school leaves the fish above the seabed and under the surface', () => {
    for (const w of wrecks) for (const s of wreckSchoolsFor(WORLD_SEED, w, WRECK_RESIDENTS)) {
      expect(s.hold!.h - s.hold!.r, `${w.id}`).toBeGreaterThanOrEqual(0.3);
      expect(s.hold!.h + s.hold!.r, `${w.id}`).toBeLessThan(w.seaDepth);
    }
  });
});

describe('found, not gifted', () => {
  // Wrecks ship PRE-charted (see wreck-chart.ts's header: an empty chart read as the feature
  // being broken). Discovery is still the implemented mechanic and still has to work, so this
  // block drives it directly rather than being deleted along with the default.
  beforeEach(() => { resetChart(); setWrecksPrecharted(false); });
  afterEach(() => setWrecksPrecharted(WRECKS_PRECHARTED));

  it('starts empty and charts a wreck only once you are near its hull', () => {
    // Pinning the shipped default: wrecks are on the chart from the first frame.
    expect(WRECKS_PRECHARTED).toBe(true);
    expect(chartedWrecks()).toHaveLength(0);
    const w = byId('tug');
    expect(chartNear(w.x + WRECK_CHART_M + 80, w.z)).toHaveLength(0);
    expect(isCharted('tug')).toBe(false);
    const found = chartNear(w.x + WRECK_CHART_M - 40, w.z);
    expect(found.map((f) => f.id)).toEqual(['tug']);
    expect(isCharted('tug')).toBe(true);
  });

  it('announces a wreck once and never re-announces it', () => {
    const w = byId('barge');
    expect(chartNear(w.x, w.z)).toHaveLength(1);
    expect(chartNear(w.x, w.z)).toHaveLength(0);
    expect(chartedWrecks().map((x) => x.id)).toEqual(['barge']);
  });

  it('charts by the hull edge, so you find the end of a long wreck as well as the middle', () => {
    const w = byId('freighterC');
    const bow = wreckPoint(w, 0.5);
    const [fx, fz] = [-Math.sin(w.heading), -Math.cos(w.heading)];
    expect(chartNear(bow.x + fx * (WRECK_CHART_M - 30), bow.z + fz * (WRECK_CHART_M - 30)).map((f) => f.id)).toContain('freighterC');
  });
});
