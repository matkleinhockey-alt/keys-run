/**
 * A trolled jumper clears the water, and nothing else does.
 *
 * `game/fishing/trolling.ts` guarantees the jump roll on a trolling hookup by setting `jumpQ`
 * straight after the hookset — a fish that eats a lure at seven knots and comes up against the
 * drag almost always comes out once. This pins the half that lives in the sim: that `jumpQ`
 * actually becomes `airborne`, and that the set of fish allowed to do it is the set that does it
 * in life.
 */
import { describe, expect, it } from 'vitest';
import { startFight, stepFight, fightParamsFor } from '../src/sim/fight.js';
import { SPECIES } from '../src/content/species.js';

const rngFrom = (seed0: number) => { let s = seed0; return () => (s = (s * 16807) % 2147483647) / 2147483647; };

/** Run a fight with `jumpQ` pre-set, as the trolling hookup does, and see if it leaves the water. */
function leavesWater(key: string, weight: number, jumpQ: number): boolean {
  const rng = rngFrom(13);
  const p = fightParamsFor(key, weight, 3);
  let f = startFight(p, -900, 2620, rng);
  f = { ...f, jumpQ };
  for (let i = 0; i < 120 && f.outcome === 'fighting'; i++) {
    f = stepFight(f, { reeling: false, drag: 3 }, p, { boatX: -900, boatZ: 2600 }, rng, 1 / 30);
    if (f.airborne) return true;
  }
  return false;
}

describe('the trolling strike jump', () => {
  it('turns a queued jump into an airborne fish', () => {
    // Mahi is the archetype: hook one trolling and it is out of the water before you reach the rod.
    expect(leavesWater('mahi', 18, 2)).toBe(true);
    expect(leavesWater('sailfish', 40, 3)).toBe(true);
  });

  it('leaves a fish with nothing queued in the water', () => {
    expect(leavesWater('yellowfin', 80, 0)).toBe(false);
    expect(leavesWater('grouper', 30, 0)).toBe(false);
  });

  it('flags as jumpers exactly the fish that jump', () => {
    // The trolling hookup only guarantees a jump for `S.jump` (plus the kingfish special case),
    // so this list IS the realism contract. Everything on it clears the water in life.
    const jumpers = Object.keys(SPECIES).filter((k) => SPECIES[k].jump);
    expect(new Set(jumpers)).toEqual(new Set([
      'tarpon', 'barracuda', 'mahi', 'sailfish', 'ladyfish', 'blacktip', 'marlin', 'blackmarlin',
    ]));
    // And the ones people most expect to see jump but which do not, stay off it: a tuna sounds,
    // a wahoo runs flat and fast, a grouper goes straight into the rocks.
    for (const k of ['yellowfin', 'bluefin', 'bigeye', 'blackfin', 'albacore', 'skipjack', 'wahoo', 'grouper', 'swordfish']) {
      expect(SPECIES[k].jump, `${k} should not be a jumper`).toBeFalsy();
    }
  });
});
