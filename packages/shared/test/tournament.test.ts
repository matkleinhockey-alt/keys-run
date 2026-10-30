import { describe, expect, it } from 'vitest';
import { depthAt } from '../src/world/depth.js';
import { SPECIES, ZONE_TABLE } from '../src/content/species.js';
import {
  ALL_CAUGHT, HARBOUR, TOURNEY_COUNTDOWN_S, TOURNEY_DURATION_S, TOURNEY_CEREMONY_S, TOURNEY_NPCS, TOURNEY_POOL, TOURNEY_SPECIES,
  createTourney, drawSpecies, harbourExitRoute, inHarbour, npcEntry, npcPlan, phaseOf, recordCatch, standings, stepTourney, tryDeliver,
  type Tourney,
} from '../src/sim/tournament.js';

const T = 1000; // arbitrary host clock
const live = (s: number): number => T + TOURNEY_COUNTDOWN_S + s;
const DOCK = { x: HARBOUR.x, z: HARBOUR.z, speed: 0 };

/** A seed whose AI boats are all still out at `untilS` seconds in. */
function seedWithNpcsOutUntil(untilS: number): number {
  for (let s = 1; s < 10000; s++) if (TOURNEY_NPCS.every((_, i) => npcPlan(s, i).homeAt > untilS)) return s;
  throw new Error('no such seed');
}

function catchAll(t: Tourney, id: string, at: number): void {
  for (const key of t.species) recordCatch(t, id, key, 10, at);
}

describe('tournament species draw', () => {
  it('draws five different species, all keepable and common somewhere', () => {
    for (let seed = 0; seed < 200; seed++) {
      const s = drawSpecies(seed);
      expect(s).toHaveLength(TOURNEY_SPECIES);
      expect(new Set(s).size).toBe(TOURNEY_SPECIES);
      for (const k of s) {
        expect(TOURNEY_POOL).toContain(k);
        expect(SPECIES[k]).toBeDefined();
        expect(['tarpon', 'bonefish', 'goliath', 'hammerhead', 'lemonshark']).not.toContain(k);
        expect(Object.values(ZONE_TABLE).some((tbl) => tbl.some(([key, w]) => key === k && w >= 2))).toBe(true);
      }
    }
  });

  it('is different from one tournament to the next, and the same for everyone on one seed', () => {
    expect(drawSpecies(42)).toEqual(drawSpecies(42));
    const distinct = new Set(Array.from({ length: 30 }, (_, i) => drawSpecies(i).join(',')));
    expect(distinct.size).toBeGreaterThan(25);
  });
});

describe('tournament harbour', () => {
  it('the finish is open water you can get a boat to', () => {
    expect(depthAt(HARBOUR.x, HARBOUR.z)).toBeGreaterThan(1.2);
  });
  it('needs you in it and slowed down', () => {
    expect(inHarbour(HARBOUR.x, HARBOUR.z, 0)).toBe(true);
    expect(inHarbour(HARBOUR.x, HARBOUR.z, 8)).toBe(false);
    expect(inHarbour(HARBOUR.x + 500, HARBOUR.z, 0)).toBe(false);
  });
});

describe('harbour exit route', () => {
  it('gets from the harbour out to Hawk Channel over water deep enough for every hull', () => {
    const r = harbourExitRoute();
    expect(r.length).toBeGreaterThan(2);
    expect(Math.hypot(r[0][0] - HARBOUR.x, r[0][1] - HARBOUR.z)).toBeLessThan(15);
    for (let k = 0; k < r.length - 1; k++) {
      const [a, b] = [r[k], r[k + 1]];
      const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2);
      for (let i = 0; i <= n; i++) expect(depthAt(a[0] + (b[0] - a[0]) * (i / n), a[1] + (b[1] - a[1]) * (i / n))).toBeGreaterThan(1.5);
    }
  });
});

describe('tournament rules', () => {
  it('runs countdown → live → over on the clock', () => {
    const t = createTourney(seedWithNpcsOutUntil(TOURNEY_DURATION_S), T);
    expect(phaseOf(t, T)).toBe('countdown');
    expect(phaseOf(t, live(1))).toBe('live');
    stepTourney(t, live(TOURNEY_DURATION_S + 1));
    expect(phaseOf(t, live(TOURNEY_DURATION_S + 1))).toBe('over');
    expect(t.winner).toBeNull();
  });

  it('counts only tournament species, only once, and only while lines are in', () => {
    const t = createTourney(7, T);
    const other = Object.keys(SPECIES).find((k) => !t.species.includes(k))!;
    expect(recordCatch(t, 'me', t.species[0], 10, T)).toBe(-1); // countdown
    expect(recordCatch(t, 'me', other, 10, live(5))).toBe(-1);
    expect(recordCatch(t, 'me', t.species[2], 12, live(5))).toBe(2);
    expect(recordCatch(t, 'me', t.species[2], 30, live(6))).toBe(-1);
    expect(t.entries[0].weights[2]).toBe(12);
  });

  it('first back with all five wins; not before all five, not outside the harbour, not at speed', () => {
    const t = createTourney(seedWithNpcsOutUntil(TOURNEY_DURATION_S), T);
    for (const key of t.species.slice(0, 4)) recordCatch(t, 'me', key, 10, live(60));
    expect(tryDeliver(t, 'me', DOCK, live(300))).toBe(false); // four of five
    catchAll(t, 'me', live(310));
    expect(t.entries[0].mask).toBe(ALL_CAUGHT);
    expect(tryDeliver(t, 'me', { ...DOCK, speed: 10 }, live(320))).toBe(false);
    expect(tryDeliver(t, 'me', { ...DOCK, x: DOCK.x + 400 }, live(320))).toBe(false);
    catchAll(t, 'pal', live(310));
    expect(tryDeliver(t, 'me', DOCK, live(330))).toBe(true);
    expect(tryDeliver(t, 'pal', DOCK, live(331))).toBe(false); // already decided
    expect(t.winner?.id).toBe('me');
    expect(phaseOf(t, live(330 + TOURNEY_CEREMONY_S - 1))).toBe('ceremony');
    expect(phaseOf(t, live(330 + TOURNEY_CEREMONY_S + 1))).toBe('over');
  });

  it('an AI boat home first wins, even if the player only reports in afterwards', () => {
    let seed = 1;
    while (Math.min(...TOURNEY_NPCS.map((_, i) => npcPlan(seed, i).homeAt)) > TOURNEY_DURATION_S - 60) seed++;
    const t = createTourney(seed, T);
    const first = Math.min(...TOURNEY_NPCS.map((_, i) => npcPlan(seed, i).homeAt));
    catchAll(t, 'me', live(30));
    expect(tryDeliver(t, 'me', DOCK, live(first + 5))).toBe(false);
    expect(t.winner?.id.startsWith('npc')).toBe(true);
    expect(t.winner?.at).toBeCloseTo(first);
    expect(standings(t, live(first + 5))[0].won).toBe(true);
  });

  it('AI boats are a contest: across many tournaments they win some and miss some', () => {
    let won = 0;
    const N = 400;
    for (let seed = 0; seed < N; seed++) {
      const best = Math.min(...TOURNEY_NPCS.map((_, i) => npcPlan(seed, i).homeAt));
      if (best <= TOURNEY_DURATION_S) won++;
    }
    expect(won / N).toBeGreaterThan(0.3);
    expect(won / N).toBeLessThan(0.85);
    // Never absurdly fast: nobody boats five species and runs home in under four minutes.
    for (let seed = 0; seed < N; seed++) for (let i = 0; i < TOURNEY_NPCS.length; i++) expect(npcPlan(seed, i).homeAt).toBeGreaterThan(240);
  });

  it('AI progress builds up through the tournament and stops when it is decided', () => {
    const t = createTourney(3, T);
    const early = npcEntry(t, 0, live(1)), late = npcEntry(t, 0, live(TOURNEY_DURATION_S));
    expect(early.mask).toBe(0);
    expect(late.mask).toBeGreaterThanOrEqual(early.mask);
    catchAll(t, 'me', live(10));
    if (tryDeliver(t, 'me', DOCK, live(20))) {
      expect(npcEntry(t, 0, live(TOURNEY_DURATION_S)).mask).toBe(npcEntry(t, 0, live(20)).mask);
    }
  });
});
