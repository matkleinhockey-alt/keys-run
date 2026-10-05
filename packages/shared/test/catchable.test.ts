/**
 * The uncatchable guarantee (task brief: "Add some rare whales and dolphin pods... You can't
 * catch the whales or the dolphins either fishing"). docs/ARCHITECTURE.md's "Fish ownership —
 * three tiers" gives the mechanism: a species with `catchable: false` (content/creatures.ts's
 * `CreatureVis.catchable`) "has no server representation at all" — this file asserts that both
 * catch paths (rod and spear) actually honor that, across both the static data tables and the
 * dynamic roll/hit-test functions, rather than relying on marine mammals simply never having been
 * added to the right table (which would silently regress the moment someone adds one).
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/rng/index.js';
import { pickSpecies } from '../src/sim/fight.js';
import { fire, stepSpear, capsuleFromSpecies, type CapsuleTarget } from '../src/sim/spear.js';
import { SPECIES, ZONE_TABLE } from '../src/content/species.js';
import { VIS, isCatchable } from '../src/content/creatures.js';

const MARINE_MAMMALS = ['dolphin', 'manatee', 'pilotwhale', 'humpback'];
const DT = 1 / 30;

function runShot(targets: readonly CapsuleTarget[]) {
  let shot = fire({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  let hit = null;
  let steps = 0;
  while (shot.alive && !hit && steps < 200) {
    const r = stepSpear(shot, targets, DT);
    shot = r.shot;
    hit = r.hit;
    steps++;
  }
  return hit;
}

describe('catchable flag — static data', () => {
  it('every marine mammal is present in VIS and marked catchable:false', () => {
    for (const key of MARINE_MAMMALS) {
      expect(VIS[key], `VIS.${key} should exist`).toBeDefined();
      expect(isCatchable(key)).toBe(false);
    }
  });

  it('no SPECIES entry (the rod-fishing weight/strength table) is ever catchable:false', () => {
    for (const key of Object.keys(SPECIES)) {
      expect(isCatchable(key), `SPECIES.${key} must be catchable`).toBe(true);
    }
  });

  it('no ZONE_TABLE zone (the rod-fishing roll table) ever lists a catchable:false species', () => {
    for (const [zone, table] of Object.entries(ZONE_TABLE)) {
      for (const [key] of table) {
        expect(isCatchable(key), `ZONE_TABLE['${zone}'] lists '${key}'`).toBe(true);
        expect(MARINE_MAMMALS).not.toContain(key);
      }
    }
  });

  it('an unknown key defaults to catchable (only an explicit false excludes)', () => {
    expect(isCatchable('not-a-real-species')).toBe(true);
  });
});

describe('catchable flag — pickSpecies (rod fishing) never rolls a marine mammal', () => {
  it('across every zone in ZONE_TABLE, many rolls, with/without a hotspot bonus', () => {
    const rng = mulberry32(777);
    for (const zone of Object.keys(ZONE_TABLE)) {
      for (let i = 0; i < 300; i++) {
        const key = pickSpecies(zone, { x: 0, z: 2000 }, { hotspot: i % 2 === 0, hump: null }, rng);
        expect(MARINE_MAMMALS).not.toContain(key);
        expect(isCatchable(key)).toBe(true);
      }
    }
  });

  it('still rolls something sensible even if a future edit sneaks a marine mammal into a zone table', () => {
    // Defense-in-depth check: pickSpecies must filter at roll time, not merely rely on the data
    // being clean (see fight.ts's pickSpecies doc comment).
    const original = [...ZONE_TABLE.Reef];
    try {
      (ZONE_TABLE.Reef as Array<[string, number]>).push(['dolphin', 1000]); // huge weight — would dominate the roll if unfiltered
      const rng = mulberry32(42);
      for (let i = 0; i < 100; i++) {
        const key = pickSpecies('Reef', { x: 0, z: 1500 }, { hotspot: false, hump: null }, rng);
        expect(key).not.toBe('dolphin');
      }
    } finally {
      ZONE_TABLE.Reef.length = 0;
      ZONE_TABLE.Reef.push(...original);
    }
  });
});

describe('catchable flag — spear cannot hit a marine mammal', () => {
  it('capsuleFromSpecies marks a marine mammal catchable:false and an ordinary fish catchable:true', () => {
    expect(capsuleFromSpecies('pod-1', 'dolphin', 0, 0, 0, 0, 0, 1, 0.5).catchable).toBe(false);
    expect(capsuleFromSpecies('whale-1', 'pilotwhale', 0, 0, 0, 0, 0, 1, 0.5).catchable).toBe(false);
    expect(capsuleFromSpecies('whale-2', 'humpback', 0, 0, 0, 0, 0, 1, 0.5).catchable).toBe(false);
    expect(capsuleFromSpecies('fish-1', 'mutton', 0, 0, 0, 0, 0, 1, 0.5).catchable).toBe(true);
  });

  it('stepSpear never registers a hit on a catchable:false target sitting directly in the shaft path', () => {
    for (const key of MARINE_MAMMALS) {
      const target = capsuleFromSpecies(`${key}-1`, key, 0, 0, 5, 0, 0, 5.6, 0.6);
      expect(runShot([target])).toBeNull();
    }
  });

  it('control: stepSpear does hit an ordinary catchable target at the identical geometry', () => {
    const target = capsuleFromSpecies('fish-1', 'mutton', 0, 0, 5, 0, 0, 5.6, 0.6);
    const hit = runShot([target]);
    expect(hit).not.toBeNull();
    expect(hit!.id).toBe('fish-1');
  });

  it('a mixed target list only ever hits the catchable member, never the uncatchable one in front of it', () => {
    const dolphin = capsuleFromSpecies('pod-1', 'dolphin', 0, 0, 3, 0, 0, 3.6, 0.7); // closer to the shooter
    const mutton = capsuleFromSpecies('fish-1', 'mutton', 0, 0, 5, 0, 0, 5.6, 0.5);
    const hit = runShot([dolphin, mutton]);
    expect(hit?.id).toBe('fish-1');
  });

  it('a raw CapsuleTarget with catchable explicitly false (not built via capsuleFromSpecies) is also excluded', () => {
    const raw: CapsuleTarget = { id: 'x', ax: 0, ay: 0, az: 5, bx: 0, by: 0, bz: 5.6, radius: 0.5, catchable: false };
    expect(runShot([raw])).toBeNull();
  });
});
