/**
 * Buying things, and what owning them changes. See sim/shop.ts's header for why every effect
 * collapses into one `Modifiers` bag instead of each system asking about item ids.
 */
import { describe, expect, it } from 'vitest';
import { STARTER_TACKLE, TACKLE_KEY_PREFIX, ownedTackle, tackleById } from '../src/content/tackle.js';
import { VENUES } from '../src/content/venues.js';
import {
  buy, emptyInventory, modifiersFor, useOne, countOf, has, pruneBuffs, buffActive,
  NO_MODIFIERS, slotOf, BUFF_SECONDS, type Inventory,
} from '../src/sim/shop.js';

const own = (...buys: Array<[keyof typeof VENUES, string]>): Inventory => {
  let inv = emptyInventory();
  for (const [v, id] of buys) inv = buy(inv, v, id, 1e6, 0).inventory;
  return inv;
};

describe('the shelf', () => {
  /**
   * Items deliberately kept off the shelf, with the reason. Anything NOT in here must be live:
   * the point of this suite is that the town does not promise what it cannot deliver, and
   * "status: 'planned'" is how 35 items shipped as decoration in the first place. Delisting has to
   * be a decision someone wrote down, not a default.
   */
  const DELISTED: Readonly<Record<string, string>> = {
    fuel: 'No fuel tank exists in sim/boat.ts. A tank that can run dry strands the player; one that cannot is a gauge that never matters.',
  };

  it('no venue advertises something for "one day" — the copy promises only what ships', () => {
    // The complaint this comes from: the town was full of things described as coming later, which
    // reads as a broken game rather than a roadmap. Two blurbs went on saying a round / a hot
    // breakfast "will one day" do something for months after both buffs were actually wired, and
    // the Stop-N-Go promised fuel that is deliberately delisted. Prose is the one part of a shop
    // nothing else type-checks, so it gets a guard of its own.
    // "will be <anything>" is deliberately broad: the tackle shop's own blurb read "this is where
    // better tackle will be bought" for as long as the ladder went unsold, and a narrower pattern
    // let exactly that through when this guard was first written.
    const FUTURE = /\bwill (?:one day|soon|be)\b|\bone day\b|\bcoming (?:soon|later)\b|\bnot yet\b/i;
    for (const v of Object.values(VENUES)) {
      for (const [field, text] of [['blurb', v.blurb], ['tagline', v.tagline]] as const) {
        expect(FUTURE.test(text), `${v.id} ${field} promises something later: "${text}"`).toBe(false);
      }
      for (const s of v.sells) {
        if (s.status !== 'live') continue;
        expect(FUTURE.test(s.blurb), `${v.id}/${s.id} blurb promises something later`).toBe(false);
      }
    }
  });

  it('every item is for sale, priced, and maps to an effect — or is delisted on purpose', () => {
    for (const v of Object.values(VENUES)) {
      for (const s of v.sells) {
        if (s.status === 'planned') {
          expect(DELISTED[s.id], `${v.id}/${s.id} is off the shelf with no recorded reason`).toBeTruthy();
          continue;
        }
        expect(s.status, `${v.id}/${s.id}`).toBe('live');
        expect(s.price, `${v.id}/${s.id} price`).toBeGreaterThan(0);
        expect(s.effect.key, `${v.id}/${s.id} effect`).toMatch(/\./);
      }
    }
  });

  it('no gear or buff item is inert — nothing takes your money and does nothing', () => {
    // The failure this catches is a shop item that charges you and changes nothing, which is worse
    // than one honestly greyed out.
    //
    // The first version of this test only looked at `kind === 'gear'`, and two buffs (bar.beer and
    // diner.breakfast) shipped inert straight through it — found by the agent wiring the buff
    // consumers, not by the test that existed to prevent exactly this. Buffs are the easier kind
    // to miss, because they only exist while their timer runs.
    for (const v of Object.values(VENUES)) {
      for (const s of v.sells) {
        if (s.effect.kind !== 'gear' && s.effect.kind !== 'buff') continue;
        const inv = own([v.id, s.id]);
        // A line rung does not act through the modifier bag and must not: the bag is what the rod
        // and reel MULTIPLY the rung by, so folding a rung in there would count it twice. Its
        // effect is that it replaces the outfit the fight is normalised against, so that is what
        // gets checked — the guarantee ("it does something for your money") is the same one.
        if (s.effect.key.startsWith(TACKLE_KEY_PREFIX)) {
          const got = ownedTackle(inv.gear);
          expect(got.id, `${v.id}/${s.id} did not become the rung in use`).toBe(s.effect.key.slice(TACKLE_KEY_PREFIX.length));
          expect(got.lineLb, `${v.id}/${s.id} is not an upgrade on the starter`).toBeGreaterThan(tackleById(STARTER_TACKLE).lineLb);
          continue;
        }
        const m = modifiersFor(inv, 0);
        expect(JSON.stringify(m), `${v.id}/${s.id} (${s.effect.key}) is inert`).not.toBe(JSON.stringify(NO_MODIFIERS));
      }
    }
  });

  it('every buff has a duration — one without is a buff that expires instantly', () => {
    for (const v of Object.values(VENUES)) {
      for (const s of v.sells) {
        if (s.effect.kind !== 'buff') continue;
        expect(BUFF_SECONDS[s.effect.key], `${v.id}/${s.id} has no BUFF_SECONDS`).toBeGreaterThan(0);
      }
    }
  });
});

describe('buying', () => {
  it('refuses what you cannot afford, and takes nothing', () => {
    const r = buy(emptyInventory(), 'dive', 'tank-pony', 10, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('cannot-afford');
    expect(r.cost).toBe(0);
    expect(r.inventory).toEqual(emptyInventory());
  });

  it('refuses to sell the same gear twice', () => {
    const once = own(['dive', 'fins-long']);
    expect(buy(once, 'dive', 'fins-long', 1e6, 0).reason).toBe('already-owned');
  });

  it('does not mutate what it is given', () => {
    const before = emptyInventory();
    const snapshot = JSON.stringify(before);
    buy(before, 'dive', 'fins-long', 1e6, 0);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('consumables stack and are spent one at a time', () => {
    let inv = own(['tackle', 'bait-shrimp']);
    expect(countOf(inv, 'bait.shrimp')).toBe(12);
    inv = buy(inv, 'tackle', 'bait-shrimp', 1e6, 0).inventory;
    expect(countOf(inv, 'bait.shrimp')).toBe(24);
    inv = useOne(inv, 'bait.shrimp');
    expect(countOf(inv, 'bait.shrimp')).toBe(23);
  });

  it('spending a consumable you do not have is a no-op you can detect', () => {
    const inv = emptyInventory();
    expect(useOne(inv, 'bait.shrimp')).toBe(inv);
  });

  it('a cosmetic is worn as soon as it is bought, one per slot', () => {
    const inv = own(['gifts', 'shirt-hawaiian']);
    expect(inv.wearing[slotOf('cosmetic.shirt.hawaiian')]).toBe('cosmetic.shirt.hawaiian');
  });
});

describe('buffs', () => {
  it('expire, and a second one re-times rather than stacking', () => {
    let inv = buy(emptyInventory(), 'diner', 'coffee', 1e6, 0).inventory;
    expect(buffActive(inv, 'diner.coffee', 100)).toBe(true);
    expect(buffActive(inv, 'diner.coffee', 10_000)).toBe(false);
    inv = buy(inv, 'diner', 'coffee', 1e6, 500).inventory;
    expect(buffActive(inv, 'diner.coffee', 1000)).toBe(true);
    expect(pruneBuffs(inv, 10_000).buffs).toEqual({});
  });

  it('drinking is a liability, not a buff', () => {
    const drunk = modifiersFor(buy(emptyInventory(), 'liquor', 'sixer', 1e6, 0).inventory, 0);
    expect(drunk.sway).toBeGreaterThan(0);
    expect(drunk.steadyMul).toBeLessThan(1);
  });
});

describe('the dive shop is the reason to go to town', () => {
  it('a pony bottle more than doubles bottom time, and the kit stacks', () => {
    expect(modifiersFor(own(['dive', 'tank-pony']), 0).breathMul).toBeGreaterThan(2);
    const full = modifiersFor(own(['dive', 'tank-pony'], ['dive', 'wetsuit'], ['dive', 'fins-long']), 0);
    expect(full.breathMul).toBeGreaterThan(2.5);
    expect(full.swimMul).toBeGreaterThan(1.2);
  });

  it('owning nothing changes nothing', () => {
    expect(modifiersFor(emptyInventory(), 0)).toEqual(NO_MODIFIERS);
  });

  it('a pony bottle comes with a fill, so it is never $4,500 of nothing', () => {
    // The bottle is live only while you hold a fill. Selling one without is a trap: the most
    // expensive item in town silently does nothing until you spot a $12 item two rows down.
    expect(countOf(own(['dive', 'tank-pony']), 'dive.fill')).toBeGreaterThan(0);
  });

  it('gear is permanent — it survives a buff sweep', () => {
    const inv = pruneBuffs(own(['dive', 'tank-pony']), 1e9);
    expect(has(inv, 'dive.tank')).toBe(true);
  });
});
