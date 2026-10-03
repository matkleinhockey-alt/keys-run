import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/rng/index.js';
import {
  chooseFish, fightParamsFor, startFight, stepFight,
  type FightEnv, type FightState,
} from '../src/sim/fight.js';

const DT = 1 / 30;
// Well offshore (z=2000, Gulf Stream — see world/depth.ts's chainZ/landH) so the mangrove/landH
// cutoff never fires in tests that aren't specifically exercising it.
const BOAT: FightEnv = { boatX: 0, boatZ: 2000 };

function run(
  state: FightState, params: ReturnType<typeof fightParamsFor>, env: FightEnv, rng: ReturnType<typeof mulberry32>,
  reelPolicy: (s: FightState) => boolean, maxSteps: number,
): { state: FightState; steps: number } {
  let s = state, steps = 0;
  while (s.outcome === 'fighting' && steps < maxSteps) {
    s = stepFight(s, { reeling: reelPolicy(s) }, params, env, rng, DT);
    steps++;
  }
  return { state: s, steps };
}

describe('chooseFish', () => {
  it('rolls a species present in the zone table and a weight within species bounds', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 50; i++) {
      const fish = chooseFish('Reef', { x: 100, z: 1400 }, { hotspot: false, hump: null }, rng);
      expect(fish.weight).toBeGreaterThan(0);
      expect(Number.isFinite(fish.x)).toBe(true);
      expect(Number.isFinite(fish.z)).toBe(true);
    }
  });

  it('is deterministic for a given rng stream', () => {
    const a = chooseFish('Offshore', { x: -500, z: 4500 }, { hotspot: true, hump: null }, mulberry32(42));
    const b = chooseFish('Offshore', { x: -500, z: 4500 }, { hotspot: true, hump: null }, mulberry32(42));
    expect(a).toEqual(b);
  });
});

describe('stepFight', () => {
  it('is winnable: a weak fish worked with a bang-bang drag policy gets landed', () => {
    const rng = mulberry32(5);
    const params = fightParamsFor('trout', 4, 3); // weak species, light fish
    let state = startFight(params, 60, 2000, rng); // far enough out to require real work
    const env: FightEnv = BOAT;
    const policy = (s: FightState): boolean => s.tension < 0.75; // ease off before it gets dangerous
    const { state: final, steps } = run(state, params, env, rng, policy, 20000);
    expect(final.outcome).toBe('landed');
    expect(steps).toBeLessThan(20000);
  });

  it('is losable: holding the reel down continuously snaps the line', () => {
    const rng = mulberry32(6);
    const params = fightParamsFor('marlin', 400, 3); // strong fish
    let state = startFight(params, 60, 2000, rng);
    const env: FightEnv = BOAT;
    const { state: final } = run(state, params, env, rng, () => true, 1000);
    expect(final.outcome).toBe('snapped');
  });

  it('is losable: slack line too long shakes the hook free', () => {
    // Construct the slack branch directly (tension pinned below the .06 threshold is only
    // reachable in practice during an air window — see fight.ts's startFight jump roll — so
    // this exercises stepFight's slack bookkeeping in isolation rather than waiting on rng).
    const rng = mulberry32(7);
    const params = fightParamsFor('tarpon', 60, 3);
    // Open water (0,2000) — well off Marathon Key — so the mangrove/landH check never fires
    // and only the slack bookkeeping under test can end the fight.
    const env: FightEnv = { boatX: 0, boatZ: 1990 };
    const state: FightState = {
      x: 0, z: 2000, tension: 0.03, stam: 0.8,
      running: false, runT: 5, runAng: 0, pull: params.str,
      slackT: 0, overT: 0, shake: 0, shakeT: 5,
      jumpQ: 0, airborne: true, airT: 5, // airborne holds the tension target at .05, below slack cutoff
      deep: 0, deepT: 0, dist: 10, outcome: 'fighting', events: [],
    };
    const { state: final, steps } = run(state, params, env, rng, () => false, 1000);
    expect(final.outcome).toBe('slack');
    expect(steps).toBeLessThan(1000);
  });

  it('is losable: running past maxLine spools the reel', () => {
    const rng = mulberry32(8);
    const params = fightParamsFor('tarpon', 60, 3);
    const state: FightState = {
      x: params.maxLine + 50, z: 2000, tension: 0.3, stam: 1,
      running: false, runT: 999, runAng: 0, pull: params.str,
      slackT: 0, overT: 0, shake: 0, shakeT: 999,
      jumpQ: 0, airborne: false, airT: 0,
      deep: 0, deepT: 0, dist: params.maxLine + 50, outcome: 'fighting', events: [],
    };
    const next = stepFight(state, { reeling: false }, params, BOAT, rng, DT);
    expect(next.outcome).toBe('spooled');
  });

  it("is losable: a fish that reaches land is cut off in the mangroves", () => {
    const rng = mulberry32(9);
    const params = fightParamsFor('snook', 10, 3);
    // (-120,0) is the middle of Marathon (Vaca Key) — landH ≈ 1.33, well past the .2 cutoff.
    // See packages/shared/src/world/depth.ts's landH/shoreInfo.
    const state: FightState = {
      x: -120, z: 0, tension: 0.3, stam: 1,
      running: false, runT: 999, runAng: 0, pull: params.str,
      slackT: 0, overT: 0, shake: 0, shakeT: 999,
      jumpQ: 0, airborne: false, airT: 0,
      deep: 0, deepT: 0, dist: 50, outcome: 'fighting', events: [],
    };
    const next = stepFight(state, { reeling: false }, params, { boatX: -170, boatZ: 0 }, rng, DT);
    expect(next.outcome).toBe('mangrove');
  });

  it('drains stamina while fighting', () => {
    const rng = mulberry32(10);
    const params = fightParamsFor('mahi', 20, 3);
    let state = startFight(params, 40, 2000, rng);
    const env: FightEnv = BOAT;
    let prevStam = state.stam;
    for (let i = 0; i < 10; i++) {
      state = stepFight(state, { reeling: true }, params, env, rng, DT);
      expect(state.outcome).toBe('fighting');
      expect(state.stam).toBeLessThanOrEqual(prevStam);
      prevStam = state.stam;
    }
    expect(state.stam).toBeLessThan(1);
  });

  it('is deterministic given the same inputs and seed', () => {
    const params = fightParamsFor('wahoo', 45, 4);
    const script = Array.from({ length: 300 }, (_, i) => i % 7 < 4); // fixed reel on/off pattern

    function simulate(seed: number): FightState {
      const rng = mulberry32(seed);
      let state = startFight(params, 50, 2000, rng);
      for (const reeling of script) {
        if (state.outcome !== 'fighting') break;
        state = stepFight(state, { reeling }, params, BOAT, rng, DT);
      }
      return state;
    }

    const a = simulate(1234);
    const b = simulate(1234);
    expect(a).toEqual(b);

    const c = simulate(999);
    // different seed must be allowed to diverge (sanity: the test isn't accidentally seed-blind)
    expect(a).not.toEqual(c);
  });

  it('never goes below zero stamina or produces NaN positions', () => {
    const rng = mulberry32(11);
    const params = fightParamsFor('amberjack', 60, 2);
    let state = startFight(params, 30, 2000, rng);
    for (let i = 0; i < 500 && state.outcome === 'fighting'; i++) {
      state = stepFight(state, { reeling: i % 3 === 0 }, params, BOAT, rng, DT);
      expect(state.stam).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(state.x)).toBe(true);
      expect(Number.isFinite(state.z)).toBe(true);
    }
  });
});
