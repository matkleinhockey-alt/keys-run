/**
 * The chum rules (sim/chum.ts): a shot bird in the water pulls the toothy species in, and only
 * them, and stops mattering with distance and with time.
 *
 * The four things these pin are the four ways the feature can be quietly broken without anything
 * throwing: the wrong fish turn up, the pull does not fall off so the whole chart converges, the
 * carcass never goes cold, or several carcasses average into a pull toward empty water.
 */
import { describe, expect, it } from 'vitest';
import {
  CARCASS_LIFE_S, CARCASS_MAX, CARCASS_REACH_M, SCAVENGER_KEYS,
  admitCarcass, carcassPotency, carcassReach, carcassSpent, chumPull, createCarcass,
  isScavenger, stepCarcass, stepCarcasses,
} from '../src/sim/chum.js';
import { VIS, isCatchable } from '../src/content/creatures.js';
import { SPECIES } from '../src/content/species.js';

/** A carcass at the origin, aged to `age` seconds — the usual fixture. */
const aged = (age: number) => ({ ...createCarcass('c', 0, 0), age });

describe('which species a carcass attracts', () => {
  it('attracts the big, toothy ones', () => {
    for (const key of ['bullshark', 'tigershark', 'hammerhead', 'blacktip', 'lemonshark', 'barracuda', 'jackcrevalle', 'amberjack', 'cobia', 'kingfish', 'wahoo', 'tarpon', 'goliath']) {
      expect(isScavenger(key), `${key} should come to a carcass`).toBe(true);
      expect(chumPull(key, 5, 0, [aged(10)]), `${key} should feel a carcass 5 m away`).not.toBeNull();
    }
  });

  it('does not attract bait, reef fish, billfish, filter feeders or marine mammals', () => {
    // One per reason it is excluded (see SCAVENGER_KEYS' doc comment).
    const out = [
      'yellowtail', 'mangrove', 'bluerunner', 'schoolmaster', 'lookdown', 'palometa', // bait + reef
      'yellowfin', 'bluefin', 'skipjack', 'albacore', 'bigeye', // tunas blitz bait, they do not scavenge
      'marlin', 'blackmarlin', 'sailfish', 'swordfish', // bill-feeders
      'nurse', 'whaleshark', 'giantmanta', 'sawfish', // suction/filter/benthic feeders
      'dolphin', 'pilotwhale', 'humpback', 'manatee', 'turtle', // not this game's scene
      'bonefish', 'permit', 'snook', 'redfish', 'trout', 'hogfish', 'grouper', 'gag', 'redgrouper',
    ];
    for (const key of out) {
      expect(isScavenger(key), `${key} must NOT come to a carcass`).toBe(false);
      // Not merely "no pull at range" — no pull even sitting right on top of a fresh one.
      expect(chumPull(key, 0, 0, [aged(CARCASS_LIFE_S * 0.25)]), `${key} on top of a carcass`).toBeNull();
    }
  });

  it('every scavenger is a real, catchable, big-bodied species', () => {
    // Guards the list against typos and against someone adding a 40 cm fish to it: the whole
    // point is that a carcass draws things bigger than what was already there.
    for (const key of SCAVENGER_KEYS) {
      const V = VIS[key];
      expect(V, `${key} is not in VIS`).toBeDefined();
      expect(SPECIES[key], `${key} is not in SPECIES`).toBeDefined();
      expect(isCatchable(key), `${key} must be catchable`).toBe(true);
      expect(V.len, `${key} is only ${V.len} m long`).toBeGreaterThanOrEqual(0.8);
    }
  });
});

describe('attraction falls off with distance', () => {
  const c = [aged(CARCASS_LIFE_S * 0.25)]; // mid-plateau, full potency

  it('is strongest on top of the carcass and weakens monotonically outward', () => {
    let prev = Infinity;
    for (const d of [0, 5, 10, 20, 30, 40, 50]) {
      const p = chumPull('bullshark', d, 0, c);
      expect(p, `${d} m`).not.toBeNull();
      expect(p!.k, `${d} m should be weaker than ${d - 10} m`).toBeLessThan(prev);
      prev = p!.k;
    }
  });

  it('does not reach past CARCASS_REACH_M', () => {
    expect(chumPull('bullshark', CARCASS_REACH_M + 1, 0, c)).toBeNull();
    expect(chumPull('bullshark', 400, 0, c)).toBeNull();
  });

  it('points at the carcass, not at the origin', () => {
    const off = [{ ...createCarcass('c', 120, -40), age: CARCASS_LIFE_S * 0.25 }];
    const p = chumPull('tigershark', 140, -40, off);
    expect(p).not.toBeNull();
    expect(p!.x).toBe(120);
    expect(p!.z).toBe(-40);
  });
});

describe('attraction falls off with time', () => {
  it('blooms in rather than snapping to full strength', () => {
    expect(carcassPotency(aged(0))).toBe(0);
    expect(carcassPotency(aged(0.5))).toBeLessThan(carcassPotency(aged(2)));
    expect(carcassPotency(aged(2))).toBeLessThan(carcassPotency(aged(3)));
    expect(carcassPotency(aged(3))).toBeCloseTo(1, 5);
  });

  it('holds full for the first half of its life, then fades to nothing', () => {
    expect(carcassPotency(aged(CARCASS_LIFE_S * 0.5))).toBeCloseTo(1, 5);
    const fading = [0.6, 0.75, 0.9, 0.99].map((f) => carcassPotency(aged(CARCASS_LIFE_S * f)));
    for (let i = 1; i < fading.length; i++) expect(fading[i]).toBeLessThan(fading[i - 1]);
    expect(fading[fading.length - 1]).toBeLessThan(0.05);
  });

  it('a fish at a fixed distance feels less pull as the carcass ages', () => {
    const at = (age: number) => chumPull('barracuda', 20, 0, [aged(age)])?.k ?? 0;
    expect(at(CARCASS_LIFE_S * 0.25)).toBeGreaterThan(at(CARCASS_LIFE_S * 0.75));
    expect(at(CARCASS_LIFE_S * 0.75)).toBeGreaterThan(at(CARCASS_LIFE_S * 0.95));
  });

  it('its reach shrinks as it ages, but holds what is already on it', () => {
    expect(carcassReach(aged(CARCASS_LIFE_S * 0.25))).toBeCloseTo(CARCASS_REACH_M, 5);
    const late = carcassReach(aged(CARCASS_LIFE_S * 0.99));
    expect(late).toBeLessThan(CARCASS_REACH_M * 0.55);
    expect(late).toBeGreaterThan(0); // a fish milling 5 m off it must not be dropped in one frame
  });
});

describe('a carcass expires', () => {
  it('is spent at its life, and then pulls nothing at any distance', () => {
    expect(carcassSpent(aged(CARCASS_LIFE_S - 1))).toBe(false);
    expect(carcassSpent(aged(CARCASS_LIFE_S))).toBe(true);
    expect(carcassPotency(aged(CARCASS_LIFE_S))).toBe(0);
    expect(chumPull('bullshark', 0, 0, [aged(CARCASS_LIFE_S)])).toBeNull();
    expect(chumPull('bullshark', 0, 0, [aged(CARCASS_LIFE_S * 10)])).toBeNull();
  });

  it('stepCarcass ages it without mutating the input, and stepCarcasses drops it when spent', () => {
    const c0 = createCarcass('c', 1, 2);
    const c1 = stepCarcass(c0, undefined, 0.5);
    expect(c0.age).toBe(0); // the house step* convention: new state out, input untouched
    expect(c1.age).toBe(0.5);

    // Run a real clock until it dies, and check it dies once and stays dead.
    let live = [createCarcass('a', 0, 0)];
    const DT = 1 / 30;
    for (let i = 0; i < Math.round((CARCASS_LIFE_S - 1) / DT); i++) live = stepCarcasses(live, undefined, DT);
    expect(live.length).toBe(1);
    for (let i = 0; i < Math.round(2 / DT); i++) live = stepCarcasses(live, undefined, DT);
    expect(live.length).toBe(0);
    expect(stepCarcasses(live, undefined, DT).length).toBe(0);
  });
});

describe('several carcasses at once', () => {
  it('a fish commits to the best one instead of being pulled to the average', () => {
    // Two carcasses 80 m apart with a shark exactly between them. Summing/averaging would aim it
    // at (0,0), where there is nothing; the rule is "pick the best offer".
    const two = [
      { ...createCarcass('a', -40, 0), age: CARCASS_LIFE_S * 0.25 },
      { ...createCarcass('b', 40, 0), age: CARCASS_LIFE_S * 0.9 }, // same distance, nearly spent
    ];
    const p = chumPull('bullshark', 0, 0, two);
    expect(p).not.toBeNull();
    expect(p!.x).toBe(-40); // the fresher one
  });

  it('prefers a fresh carcass further away over a spent one close by', () => {
    const p = chumPull('hammerhead', 0, 0, [
      { ...createCarcass('stale', 8, 0), age: CARCASS_LIFE_S * 0.97 },
      { ...createCarcass('fresh', 0, 35), age: CARCASS_LIFE_S * 0.2 },
    ]);
    expect(p!.z).toBe(35);
  });

  it('the pull never exceeds 1, however many are in the water', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ ...createCarcass(`c${i}`, i * 0.1, 0), age: CARCASS_LIFE_S * 0.25 }));
    const p = chumPull('bullshark', 0, 0, many);
    expect(p!.k).toBeLessThan(1);
  });

  it('admitCarcass caps the water at CARCASS_MAX and drops the oldest', () => {
    let list: ReturnType<typeof admitCarcass> = [];
    for (let i = 0; i < CARCASS_MAX + 3; i++) {
      list = admitCarcass(list, { ...createCarcass(`c${i}`, i, 0), age: CARCASS_MAX + 3 - i });
      expect(list.length).toBeLessThanOrEqual(CARCASS_MAX);
    }
    expect(list.length).toBe(CARCASS_MAX);
    // The survivors are the youngest, i.e. the last ones added.
    expect(list.map((c) => c.id)).toEqual(['c3', 'c4', 'c5', 'c6']);
  });
});
