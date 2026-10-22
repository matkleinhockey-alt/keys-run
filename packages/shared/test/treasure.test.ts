/**
 * Treasure in the wrecks (sim/treasure.ts): that a wreck holds the same loot forever, that an
 * emptied container stays emptied, and that the payout is inside the band the economy was tuned
 * against. The three things a player would notice being wrong, in that order.
 */
import { describe, expect, it } from 'vitest';
import { wrecksFor, wreckEdgeDist } from '../src/world/wrecks.js';
import { AMMO_KEY } from '../src/sim/handgun.js';
import { countOf, emptyInventory, startingInventory } from '../src/sim/shop.js';
import {
  applyLoot, containerCount, containersFor, createTreasureState, isOpened, lootOf,
  nearestUnopened, reachPrompt, stepOpenContainer, totalTreasureAmmo, totalTreasureCash,
  REACH_M, TOTAL_CASH_BAND, type Container,
} from '../src/sim/treasure.js';

const SEED = 20240817;
const SEEDS = [SEED, 1, 777, 99, 123456];
/** The tests work in a flat-seabed world: the wreck's own `seaDepth` is the only height that
 * matters to `nearestUnopened`, and a real terrain sampler is the client's business. */
const flatFloor = (depth: number) => (): number => -depth;

describe('containers on a wreck', () => {
  it('every wreck has containers, led by a strongbox, and a can once there are three', () => {
    for (const seed of SEEDS) {
      for (const w of wrecksFor(seed)) {
        const cs = containersFor(seed, w);
        expect(cs.length, w.id).toBe(containerCount(w));
        expect(cs.length, w.id).toBeGreaterThanOrEqual(2);
        expect(cs[0].kind, `${w.id} first container`).toBe('strongbox');
        if (cs.length >= 3) {
          expect(cs.some((c) => c.kind === 'ammocan'), `${w.id} has no ammo can`).toBe(true);
        }
      }
    }
  });

  it('they lie in the sand just outside the hull, spread along it', () => {
    for (const w of wrecksFor(SEED)) {
      const cs = containersFor(SEED, w);
      for (const c of cs) {
        const d = wreckEdgeDist(w, c.x, c.z);
        // `wreckEdgeDist` measures from the hull's side, so this is literally "metres of sand
        // between the box and the plating" — close enough to see the wreck, never inside it.
        expect(d, `${c.id} is ${d.toFixed(1)} m from the hull`).toBeGreaterThan(0.5);
        expect(d, `${c.id} is ${d.toFixed(1)} m from the hull`).toBeLessThan(13);
      }
      // Never two in reach at once (`MIN_SEPARATION_M`, which is why this is 2x REACH_M rather
      // than an arbitrary "not in a heap" number): standing between two boxes made the prompt
      // flicker between them.
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          expect(Math.hypot(cs[i].x - cs[j].x, cs[i].z - cs[j].z), `${cs[i].id} vs ${cs[j].id}`).toBeGreaterThan(2 * REACH_M);
        }
      }
    }
  });

  it('comes to rest on flat ground, not inside a coral head', () => {
    // The thing this guards is a screenshot: before the site search existed, the tug's strongbox
    // sat 3.3 m up the side of a coral boulder and the ammo can was wedged in a crevice between
    // two more. `reliefM` is what the search minimised, so assert the result.
    for (const seed of SEEDS) {
      for (const w of wrecksFor(seed)) {
        for (const c of containersFor(seed, w)) {
          expect(Math.abs(c.reliefM), `${c.id} sits on ${c.reliefM.toFixed(2)} m of relief`).toBeLessThanOrEqual(0.6);
        }
      }
    }
  });

  it('ids are stable per wreck, so adding a wreck cannot renumber another one\'s boxes', () => {
    const ids = wrecksFor(SEED).flatMap((w) => containersFor(SEED, w).map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const w of wrecksFor(SEED)) {
      for (const c of containersFor(SEED, w)) expect(c.id.startsWith(w.id + ':')).toBe(true);
    }
  });
});

describe('determinism', () => {
  it('the same wreck holds the same treasure, every call', () => {
    for (const w of wrecksFor(SEED)) {
      const a = containersFor(SEED, w).map((c) => ({ ...c, loot: lootOf(SEED, w, c) }));
      // Re-derive from a fresh wreck list: `containersFor` caches, so this also proves the cache
      // is not what is making it look stable.
      const w2 = wrecksFor(SEED).find((q) => q.id === w.id)!;
      const b = containersFor(SEED, w2).map((c) => ({ ...c, loot: lootOf(SEED, w2, c) }));
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });

  it('a different seed is a different hoard', () => {
    const a = JSON.stringify(wrecksFor(SEED).flatMap((w) => containersFor(SEED, w).map((c) => lootOf(SEED, w, c))));
    const b = JSON.stringify(wrecksFor(99).flatMap((w) => containersFor(99, w).map((c) => lootOf(99, w, c))));
    expect(b).not.toBe(a);
  });
});

describe('opening one', () => {
  const firstBox = (seed = SEED): { wreck: ReturnType<typeof wrecksFor>[number]; container: Container } => {
    const wreck = wrecksFor(seed)[0];
    return { wreck, container: containersFor(seed, wreck)[0] };
  };

  it('pays its loot once and is empty for good', () => {
    const { wreck, container } = firstBox();
    let state = createTreasureState();
    expect(isOpened(state, container.id)).toBe(false);

    const first = stepOpenContainer(state, { seed: SEED, wreck, container });
    expect(first.loot).not.toBeNull();
    expect(first.loot!.cash).toBeGreaterThan(0);
    expect(first.state).not.toBe(state);
    state = first.state;
    expect(isOpened(state, container.id)).toBe(true);

    const second = stepOpenContainer(state, { seed: SEED, wreck, container });
    expect(second.loot, 'a looted container must pay nothing the second time').toBeNull();
    // Same reference back: the caller uses that to skip a pointless save.
    expect(second.state).toBe(state);
    expect(state.opened.length).toBe(1);
  });

  it('does not touch its neighbours, and never mutates the state it was given', () => {
    const wreck = wrecksFor(SEED)[3];
    const cs = containersFor(SEED, wreck);
    const before = createTreasureState();
    const after = stepOpenContainer(before, { seed: SEED, wreck, container: cs[1] }).state;
    expect(before.opened).toEqual([]);
    expect(isOpened(after, cs[1].id)).toBe(true);
    for (const c of cs) if (c.id !== cs[1].id) expect(isOpened(after, c.id)).toBe(false);
  });

  it('the loot survives a round trip through JSON — it is what the client persists', () => {
    const { wreck, container } = firstBox();
    const opened = stepOpenContainer(createTreasureState(), { seed: SEED, wreck, container }).state;
    const reloaded = JSON.parse(JSON.stringify(opened)) as typeof opened;
    expect(stepOpenContainer(reloaded, { seed: SEED, wreck, container }).loot).toBeNull();
  });

  it('ammo lands in the inventory under the pistol\'s own key', () => {
    const wreck = wrecksFor(SEED).find((w) => w.id === 'freighterC')!;
    const can = containersFor(SEED, wreck).find((c) => c.kind === 'ammocan')!;
    const loot = lootOf(SEED, wreck, can);
    expect(loot.ammo).toBeGreaterThan(0);
    const inv = applyLoot(startingInventory(), loot);
    expect(countOf(inv, AMMO_KEY)).toBe(countOf(startingInventory(), AMMO_KEY) + loot.ammo);
    // A strongbox is money only, and must not pretend to be a magazine.
    const box = containersFor(SEED, wreck)[0];
    expect(lootOf(SEED, wreck, box).ammo).toBe(0);
    expect(applyLoot(emptyInventory(), lootOf(SEED, wreck, box))).toEqual(emptyInventory());
  });
});

describe('the payout band', () => {
  it('a world holds TOTAL_CASH_BAND dollars of treasure, on every seed', () => {
    for (const seed of SEEDS) {
      const total = totalTreasureCash(seed, wrecksFor(seed));
      expect(total, `seed ${seed} pays $${total}`).toBeGreaterThanOrEqual(TOTAL_CASH_BAND[0]);
      expect(total, `seed ${seed} pays $${total}`).toBeLessThanOrEqual(TOTAL_CASH_BAND[1]);
    }
  });

  it('no single container is worth a boat, and none is worth nothing', () => {
    for (const seed of SEEDS) {
      for (const w of wrecksFor(seed)) {
        for (const c of containersFor(seed, w)) {
          const { cash, ammo, label } = lootOf(seed, w, c);
          // $50 is a bait-and-ice purchase; $2,000 is a blue marlin. Outside that a container is
          // either an insult or a jackpot, and this is treasure, not a slot machine.
          expect(cash, `${c.id} pays $${cash}`).toBeGreaterThan(50);
          expect(cash, `${c.id} pays $${cash}`).toBeLessThan(2_000);
          expect(ammo, `${c.id} ammo`).toBeLessThanOrEqual(40);
          expect(label.length).toBeGreaterThan(8);
        }
      }
    }
  });

  it('the deep wrecks pay more than the shallow ones — depth is the difficulty', () => {
    const byWreck = wrecksFor(SEED).map((w) => ({
      w, cash: containersFor(SEED, w).reduce((s, c) => s + lootOf(SEED, w, c).cash, 0),
    }));
    const shallow = byWreck.filter((q) => q.w.seaDepth < 15);
    const deep = byWreck.filter((q) => q.w.seaDepth > 30);
    expect(deep.length).toBeGreaterThan(0);
    expect(Math.min(...deep.map((q) => q.cash))).toBeGreaterThan(Math.max(...shallow.map((q) => q.cash)));
  });

  it('found ammo stays a top-up, not a supply line', () => {
    for (const seed of SEEDS) {
      const rounds = totalTreasureAmmo(seed, wrecksFor(seed));
      // The gun counter's box is 50 rounds for $75. Three boxes' worth in the entire world, once.
      expect(rounds, `seed ${seed}: ${rounds} rounds`).toBeGreaterThan(60);
      expect(rounds, `seed ${seed}: ${rounds} rounds`).toBeLessThan(200);
    }
  });
});

describe('reaching one', () => {
  const wreck = wrecksFor(SEED)[2];

  it('finds the nearest unopened container and skips the emptied ones', () => {
    const floor = flatFloor(wreck.seaDepth);
    const cs = containersFor(SEED, wreck);
    const target = cs[1];
    const hit = nearestUnopened(SEED, [wreck], createTreasureState(), target.x, floor(0, 0), target.z, REACH_M, floor);
    expect(hit?.container.id).toBe(target.id);
    expect(hit!.dist).toBeLessThan(0.001);

    const emptied = { opened: [target.id] };
    const again = nearestUnopened(SEED, [wreck], emptied, target.x, floor(0, 0), target.z, REACH_M, floor);
    expect(again, 'an emptied box must stop offering itself').toBeNull();
  });

  it('is a 3D test: floating above a strongbox is not reaching it', () => {
    const floor = flatFloor(wreck.seaDepth);
    const c = containersFor(SEED, wreck)[0];
    const atIt = nearestUnopened(SEED, [wreck], createTreasureState(), c.x, floor(0, 0), c.z, REACH_M, floor);
    expect(atIt).not.toBeNull();
    const above = nearestUnopened(SEED, [wreck], createTreasureState(), c.x, floor(0, 0) + REACH_M + 2, c.z, REACH_M, floor);
    expect(above).toBeNull();
  });

  it('the prompt names the thing, not the verb', () => {
    for (const w of wrecksFor(SEED)) {
      for (const c of containersFor(SEED, w)) {
        expect(reachPrompt(c)).toMatch(/^F {2}Prise open the \w/);
      }
    }
  });
});
