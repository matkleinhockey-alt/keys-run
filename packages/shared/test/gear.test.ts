/**
 * The gun counter and the tackle shop, end to end: every item they sell has to change something
 * the player can measure. One section per `effect.key`. Statistical tests are Monte Carlo over a
 * fixed seed (so deterministic) with margins wide enough that retuning a constant, not the shape
 * of the model, keeps them passing. Full-size numbers: apps/client/test/playthrough-model.mjs
 * (GEAR=... env) and test/spear-hitrate.mjs.
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/rng/index.js';
import { VENUES } from '../src/content/venues.js';
import { COOLER_CAP } from '../src/content/boats.js';
import { STARTER_TACKLE, tackleById } from '../src/content/tackle.js';
import { SPECIES, ZONE_TABLE } from '../src/content/species.js';
import { buy, countOf, emptyInventory, modifiersFor, NO_MODIFIERS, type Inventory } from '../src/sim/shop.js';
import {
  SPEAR_RANGE, SPEAR_RANGE_MAX, SPEAR_SPEED, SPEAR_TETHER_M, assistAim, dragKFor, fire, holdChance,
  shaftSpeedAtDist, spearFightParamsFor, spearRangeFor, startSpearFight, stepSpear, stepSpearFight,
  timeToDistance, type CapsuleTarget, type SpearFightState,
} from '../src/sim/spear.js';
import {
  DRAG_FRAC, RARE_ODDS_MAX, applyGear, dragFraction, fightParamsFor, pickSpecies, startFight, stepFight,
  type FightEnv, type FightGear, type FightOutcome, type FightState,
} from '../src/sim/fight.js';
import {
  BALLYHOO_KEY, FLUORO_KEY, ICE_BONUS_LB, ICE_KEY, SHAFT_KEY, SHRIMP_KEY, SHRIMP_BITE_MUL_HOME,
  coolerCapFor, createGearPort, rigCast, rigLeader, shaftNotice, takeShaft,
} from '../src/sim/gear.js';

const buyAll = (...ids: Array<[keyof typeof VENUES, string]>): Inventory => {
  let inv = emptyInventory();
  for (const [v, id] of ids) inv = buy(inv, v, id, 1e9, 0).inventory;
  return inv;
};

/** A mid-water target straight ahead at distance `d`, big enough that geometry is not the story. */
const targetAt = (d: number): CapsuleTarget => ({ id: 't', ax: 0, ay: 0, az: -d, bx: 0, by: 0, bz: -d - 0.6, radius: 0.5 });

/* ------------------------------------------------------------------------------------------ *
 * spear.long
 * ------------------------------------------------------------------------------------------ */
describe('spear.long — range really grows, and the edge stays unreliable', () => {
  const long = modifiersFor(buyAll(['guns', 'spear-long']), 0);

  it('the bag says +6 m and SPEAR_RANGE_MAX is exactly that ceiling', () => {
    expect(long.spearRangeM).toBe(6);
    // If the shop ever grows this bonus, world.ts's query radius would silently clip the longest
    // shot; this is the tripwire.
    expect(spearRangeFor(long.spearRangeM)).toBe(SPEAR_RANGE_MAX);
    expect(spearRangeFor(999)).toBe(SPEAR_RANGE_MAX);
    expect(spearRangeFor(0)).toBe(SPEAR_RANGE);
  });

  it('a stock shaft stops at 18 m; a long-gun shaft flies on to 24 m and hits what stock cannot', () => {
    const tgt = targetAt(21);
    const fly = (range: number): boolean => {
      let shot = fire({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, range);
      for (let i = 0; i < 400 && shot.alive; i++) {
        const r = stepSpear(shot, [tgt], 1 / 30);
        shot = r.shot;
        if (r.hit) return true;
      }
      return false;
    };
    expect(fly(spearRangeFor(0))).toBe(false);
    expect(fly(spearRangeFor(long.spearRangeM))).toBe(true);
  });

  it('keeps K\'s defining relationship: 60% of muzzle speed left at its own edge, whatever the range', () => {
    for (const r of [SPEAR_RANGE * 0.6, SPEAR_RANGE, SPEAR_RANGE_MAX]) {
      expect(shaftSpeedAtDist(r, r) / SPEAR_SPEED).toBeCloseTo(0.6, 6);
      expect(holdChance(shaftSpeedAtDist(r, r))).toBeCloseTo(0.5542, 3);
    }
  });

  it('is not a certainty anywhere: even point blank holds < 1, and the far edge holds well under it', () => {
    expect(holdChance(shaftSpeedAtDist(0, SPEAR_RANGE_MAX))).toBeLessThan(1);
    const edge = holdChance(shaftSpeedAtDist(SPEAR_RANGE_MAX, SPEAR_RANGE_MAX));
    expect(edge).toBeGreaterThan(0.3);
    expect(edge).toBeLessThan(0.7);
    // Rolled, not just computed: held-rate at the long gun's edge, through stepSpear's own roll.
    const rng = mulberry32(7);
    let held = 0; const N = 600;
    for (let i = 0; i < N; i++) {
      let shot = fire({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, SPEAR_RANGE_MAX);
      const tgt = targetAt(SPEAR_RANGE_MAX - 0.3);
      for (let k = 0; k < 400 && shot.alive; k++) {
        const r = stepSpear(shot, [tgt], 1 / 30, rng);
        shot = r.shot;
        if (r.hit) { if (r.hit.held) held++; break; }
      }
    }
    expect(held / N).toBeGreaterThan(0.3);
    expect(held / N).toBeLessThan(0.75);
  });

  it('is strictly better than stock at a shared distance (faster shaft, shorter flight)', () => {
    expect(shaftSpeedAtDist(15, SPEAR_RANGE_MAX)).toBeGreaterThan(shaftSpeedAtDist(15, SPEAR_RANGE));
    expect(timeToDistance(15, SPEAR_RANGE_MAX)).toBeLessThan(timeToDistance(15, SPEAR_RANGE));
    expect(dragKFor(SPEAR_RANGE_MAX)).toBeLessThan(dragKFor(SPEAR_RANGE));
  });

  it('assist leads for the shaft that will actually fly (range-aware time of flight)', () => {
    // A fish crossing at 2 m/s, 20 m out. With the long gun's faster shaft the lead is smaller.
    const tg = { ...targetAt(20), vx: 2 };
    const o = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: -1 };
    const stock = assistAim(o, d, [tg], { range: SPEAR_RANGE_MAX, strength: 1, cone: 1 });
    const longG = assistAim(o, d, [tg], { range: SPEAR_RANGE_MAX, strength: 1, cone: 1 });
    const spare = assistAim(o, d, [tg], { range: spearRangeFor(0, true), strength: 1, cone: 1 });
    expect(stock.targetId).toBe('t');
    expect(longG.dx).toBeCloseTo(stock.dx, 9);
    expect(spare.targetId).toBeNull(); // 20 m is beyond a spare's ~10.8 m: the assist does not lie about reach
  });
});

/* ------------------------------------------------------------------------------------------ *
 * spear.reel
 * ------------------------------------------------------------------------------------------ */
describe('spear.reel — the speared fish runs less far', () => {
  const reel = modifiersFor(buyAll(['guns', 'spear-reel']), 0);
  const env = { diverX: 0, diverZ: 0 };

  it('tether is 60% of stock, floored so it cannot pin the fish to the diver', () => {
    expect(reel.spearTetherMul).toBeCloseTo(0.6, 9);
    expect(spearFightParamsFor('yellowtail', 3).tetherMax).toBe(SPEAR_TETHER_M);
    expect(spearFightParamsFor('yellowtail', 3, reel.spearTetherMul).tetherMax).toBeCloseTo(9, 9);
    expect(spearFightParamsFor('yellowtail', 3, 0.01).tetherMax).toBe(4);
  });

  function run(tetherMul: number, seed: number): { outcome: string; t: number; maxDist: number } {
    const rng = mulberry32(seed);
    const params = spearFightParamsFor('mutton', 12, tetherMul);
    // A far hit (14 m out) is where the tether decides anything: a thrashing fish near the diver
    // wanders only ~6 m (measured), so a 9 m tether never even engages for it. The reel line pays
    // off on the shots the long gun makes possible: the fish is stopped at 9 m, not 15.
    let s: SpearFightState = startSpearFight(14, 0);
    let t = 0, maxDist = 0;
    // A competent diver: haul while the line is comfortable, ease off near the limit.
    while (s.outcome === 'fighting' && t < 120) {
      s = stepSpearFight(s, { hauling: s.tension < 0.85 }, params, env, rng, 1 / 30);
      t += 1 / 30; maxDist = Math.max(maxDist, s.dist);
    }
    return { outcome: s.outcome, t, maxDist };
  }

  it('fish never get past the shorter tether, and fights end sooner on average', () => {
    let tStock = 0, tReel = 0, nS = 0, nR = 0, maxStock = 0, maxReel = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const a = run(1, seed), b = run(reel.spearTetherMul, seed);
      maxStock = Math.max(maxStock, a.maxDist); maxReel = Math.max(maxReel, b.maxDist);
      if (a.outcome === 'landed') { tStock += a.t; nS++; }
      if (b.outcome === 'landed') { tReel += b.t; nR++; }
    }
    expect(maxReel).toBeLessThanOrEqual(9 + 1e-6);
    expect(maxStock).toBeGreaterThan(13); // the stock fish really does start and stay further out, so the gap is real
    expect(nS).toBeGreaterThan(0); expect(nR).toBeGreaterThan(0);
    expect(tReel / nR).toBeLessThan(tStock / nS);
  });

  it('is a convenience, not a guaranteed landing: tornFree still happens with the reel line', () => {
    // Hauling flat out into peak tension tears the shaft free regardless of tether.
    const params = spearFightParamsFor('grouper', 70, reel.spearTetherMul);
    const rng = mulberry32(3);
    let s = startSpearFight(5, 0), t = 0;
    while (s.outcome === 'fighting' && t < 60) { s = stepSpearFight(s, { hauling: true }, params, env, rng, 1 / 30); t += 1 / 30; }
    expect(s.outcome).toBe('tornFree');
  });
});

/* ------------------------------------------------------------------------------------------ *
 * spear.shafts
 * ------------------------------------------------------------------------------------------ */
describe('spear.shafts — consumed, legible when gone, never a dead trigger', () => {
  it('a pack is 3 shafts and each shot spends exactly one', () => {
    let inv = buyAll(['guns', 'spear-shaft']);
    expect(countOf(inv, SHAFT_KEY)).toBe(3);
    const a = takeShaft(inv); expect(a.spare).toBe(false); expect(a.left).toBe(2);
    inv = a.inventory; expect(countOf(inv, SHAFT_KEY)).toBe(2);
  });

  it('at zero it falls back to a free spare with a short range instead of refusing to fire', () => {
    let inv = buyAll(['guns', 'spear-shaft']);
    for (let i = 0; i < 3; i++) inv = takeShaft(inv).inventory;
    const t = takeShaft(inv);
    expect(countOf(inv, SHAFT_KEY)).toBe(0);
    expect(t.spare).toBe(true);
    expect(t.inventory).toBe(inv); // nothing spent, nothing goes negative
    expect(spearRangeFor(6, true)).toBeLessThan(SPEAR_RANGE); // even with the long gun, a spare is short
    expect(spearRangeFor(0, true)).toBeCloseTo(SPEAR_RANGE * 0.6, 9);
    // a fresh account (nothing bought) is never locked out of the water
    expect(takeShaft(emptyInventory()).spare).toBe(true);
  });

  it('says so out loud at 1 left, at 0 and on every spare shot, and is silent otherwise', () => {
    expect(shaftNotice(2, false)).toBeNull();
    expect(shaftNotice(1, false)).toMatch(/1 shaft left/);
    expect(shaftNotice(0, false)).toMatch(/Last shaft/);
    expect(shaftNotice(0, true)).toMatch(/Out of shafts/);
  });
});

/* ------------------------------------------------------------------------------------------ *
 * rod.heavy / rod.used / reel.lever
 * ------------------------------------------------------------------------------------------ */
const DT = 1 / 30;
/** Open Gulf Stream water: no land within any run, so only the mechanics under test end a fight. */
const BOAT: FightEnv = { boatX: -500, boatZ: 6000 };
const angler = (s: FightState): boolean => {
  if (s.airborne) return s.tension < 0.12;
  if (s.tension > s.limit * 0.7) return false;
  if (s.running) return s.stam < 0.5 && s.tension < s.limit * 0.45;
  return s.tension < s.limit * 0.65;
};
function fightOnce(key: string, weight: number, drag: number, rng: () => number, gear?: FightGear, tackleId = STARTER_TACKLE): { outcome: FightOutcome; t: number } {
  const params = fightParamsFor(key, weight, drag, tackleById(tackleId), gear);
  let s = startFight(params, BOAT.boatX + 35, BOAT.boatZ, rng);
  let t = 0, held = true, next = 0;
  while (s.outcome === 'fighting' && t < 900) {
    if (t >= next) { held = angler(s); next = t + 0.25; }
    s = stepFight(s, { reeling: held }, params, BOAT, rng, DT);
    t += DT;
  }
  return { outcome: s.outcome as FightOutcome, t };
}
/** Contested fish (>= 0.25 line ratings fresh pull on the starter), the only ones skill/gear decide. */
const CONTESTED: Array<[string, number]> = [
  ['wahoo', 85], ['tarpon', 140], ['yellowfin', 180], ['amberjack', 90], ['grouper', 75], ['marlin', 400], ['sailfish', 80], ['cobia', 80],
];
function winPct(drag: number, gear: FightGear | undefined, n: number, seed: number): number {
  const rng = mulberry32(seed);
  let w = 0, tot = 0;
  for (const [k, wt] of CONTESTED) for (let i = 0; i < n; i++) { tot++; if (fightOnce(k, wt, drag, rng, gear).outcome === 'landed') w++; }
  return 100 * w / tot;
}

describe('rod.heavy / rod.used / reel.lever — through fightParamsFor', () => {
  const heavy = modifiersFor(buyAll(['tackle', 'rod-heavy']), 0);
  const used = modifiersFor(buyAll(['pawn', 'used-rod']), 0);
  const lever = modifiersFor(buyAll(['tackle', 'reel-lever']), 0);
  const base = tackleById(STARTER_TACKLE);

  it('the bag values the shop sells are what the fight reads', () => {
    expect(heavy.lineMul).toBeGreaterThan(1); expect(heavy.reelMul).toBeLessThan(1); // heavy rod: stronger but slower
    expect(used.lineMul).toBeGreaterThan(1);
    expect(lever.reelMul).toBeGreaterThan(1); expect(lever.lineMul).toBeGreaterThan(1);
  });

  it('lineMul scales line AND leader, so the rating and the fight see one outfit', () => {
    const p0 = fightParamsFor('wahoo', 40, 3, base);
    const p1 = fightParamsFor('wahoo', 40, 3, base, heavy);
    expect(p1.ratingLb).toBeCloseTo(p0.ratingLb * heavy.lineMul, 9);
    expect(p1.tackle.reelMs).toBeCloseTo(base.reelMs * heavy.reelMul, 9);
    expect(p1.pullN).toBeCloseTo(p0.pullN / heavy.lineMul, 9);
    expect(applyGear(base, undefined)).toBe(base); // no gear: the very same object, zero drift
    expect(applyGear(base, { lineMul: 1, reelMul: 1 })).toBe(base);
  });

  it('does NOT move the drag setting: the clutch stays the same fraction of rating (drag stays a trade-off)', () => {
    for (const d of [1, 2, 3, 4, 5]) {
      for (const g of [heavy, used, lever]) {
        const p = fightParamsFor('wahoo', 40, d, base, g);
        const Dn = dragFraction(d) * p.tackle.lineLb / p.ratingLb;
        expect(Dn).toBeCloseTo(dragFraction(d), 9);
      }
    }
    expect(DRAG_FRAC.length).toBe(5);
  });

  it('reelMul changes retrieve speed: a lever reel gains line faster on a resting fish', () => {
    const run = (gear?: FightGear): number => {
      const params = fightParamsFor('snook', 8, 3, base, gear);
      const rng = mulberry32(11);
      let s: FightState = { ...startFight(params, BOAT.boatX + 30, BOAT.boatZ, rng), running: false, runT: 99, stam: 0.2, shakeT: 99 };
      for (let i = 0; i < 90; i++) s = stepFight(s, { reeling: true }, params, BOAT, rng, DT);
      return s.dist;
    };
    expect(run(lever)).toBeLessThan(run(undefined) - 0.5);
  });

  it('wins more big fish than the starter outfit, and not all of them', () => {
    // Measured (40 fights x 8 species, drag 3, attentive angler): stock ~71%, heavy rod + lever reel
    // ~85%, all three rods/reels ~87%. Big game stays a real contest on the best kit.
    const stock = winPct(3, undefined, 40, 101);
    const all = winPct(3, { lineMul: heavy.lineMul * used.lineMul * lever.lineMul, reelMul: heavy.reelMul * used.reelMul * lever.reelMul }, 40, 101);
    const hv = winPct(3, heavy, 40, 101);
    expect(hv).toBeGreaterThan(stock + 3);
    expect(all).toBeGreaterThan(stock + 5);
    expect(all).toBeLessThan(93); // losable still: a fully geared rod does not turn big game into a formality
  });

  it('keeps the fight losable and drag a real trade-off: with the best kit no drag dominates', () => {
    const kit: FightGear = { lineMul: heavy.lineMul * lever.lineMul, reelMul: heavy.reelMul * lever.reelMul };
    const wins = [1, 2, 3, 4, 5].map((d) => winPct(d, kit, 40, 202));
    // Dominance would be one end of the dial winning decisively over the rest. The pre-rebuild fight
    // had 99.9-100% at every setting with drag 5 strictly best. Measured here with the kit:
    // 76 82 85 85 85 (stock 60 67 71 70 65): the tight end has stopped paying off past 4 and the
    // loose end still costs wins, so the dial has an interior optimum rather than an end.
    const best = Math.max(...wins);
    expect(best - wins[4]).toBeLessThan(10);       // 5 is not meaningfully worse (it is a plateau)...
    expect(best - wins[0]).toBeGreaterThan(3);     // ...but the loose end really costs: drag is a dial
    expect(wins[0]).toBeLessThan(wins[2]);         // 1 loses to 3
    expect(best).toBeLessThan(95);                  // and nothing is a formality
    expect(Math.min(...wins)).toBeGreaterThan(55); // a heavy rod is not made useless by a bad dial either
  });
});

/* ------------------------------------------------------------------------------------------ *
 * bait.shrimp / bait.ballyhoo
 * ------------------------------------------------------------------------------------------ */
describe('bait.shrimp / bait.ballyhoo — spent per cast, change the wait / the roll', () => {
  it('a dozen shrimp: one per cast, bite wait x0.6 on home water, weaker elsewhere', () => {
    let inv = buyAll(['tackle', 'bait-shrimp']);
    expect(countOf(inv, SHRIMP_KEY)).toBe(12);
    const home = rigCast(inv, 'Flats');
    expect(home.bait).toBe('shrimp');
    expect(home.biteMul).toBeCloseTo(SHRIMP_BITE_MUL_HOME, 9);
    expect(countOf(home.inventory, SHRIMP_KEY)).toBe(11);
    const away = rigCast(inv, 'Offshore');
    expect(away.biteMul).toBeGreaterThan(home.biteMul);
    expect(away.biteMul).toBeLessThan(1);
    // twelve casts empty the bucket, the thirteenth is a bare hook
    for (let i = 0; i < 12; i++) inv = rigCast(inv, 'Flats').inventory;
    expect(countOf(inv, SHRIMP_KEY)).toBe(0);
    const bare = rigCast(inv, 'Flats');
    expect(bare.bait).toBeNull(); expect(bare.biteMul).toBe(1); expect(bare.inventory).toBe(inv);
  });

  it('the mean bite wait really falls (the client multiplies rand(4,10) by biteMul)', () => {
    const rng = mulberry32(5);
    const mean = (m: number): number => { let a = 0; for (let i = 0; i < 4000; i++) a += (4 + 6 * rng()) * m; return a / 4000; };
    const inv = buyAll(['tackle', 'bait-shrimp']);
    expect(mean(rigCast(inv, 'Flats').biteMul) / mean(1)).toBeCloseTo(0.6, 1);
  });

  it('ballyhoo skews the species roll rarer without making a rare fish certain', () => {
    const inv = buyAll(['tackle', 'bait-ballyhoo']);
    expect(countOf(inv, BALLYHOO_KEY)).toBe(6);
    const rig = rigCast(inv, 'Offshore');
    expect(rig.bait).toBe('ballyhoo');
    expect(rig.rareMul).toBeGreaterThan(1);
    expect(countOf(rig.inventory, BALLYHOO_KEY)).toBe(5);
    // The Reef table, not Offshore: Offshore's roll is already tilted to big fish by `offshoreF`
    // (a 76% "rare" share before any bait), which would saturate the measurement.
    const RARE = new Set(ZONE_TABLE.Reef.filter(([, v]) => v <= RARE_ODDS_MAX).map(([k]) => k));
    const share = (rareMul: number | undefined): { rare: number; top: number } => {
      const rng = mulberry32(99);
      let r = 0, m = 0; const N = 8000;
      for (let i = 0; i < N; i++) {
        const k = pickSpecies('Reef', { x: 0, z: 0 }, { hotspot: false, hump: null, rareMul }, rng);
        if (RARE.has(k)) r++; if (k === 'yellowtail') m++;
      }
      return { rare: r / N, top: m / N };
    };
    const plain = share(undefined), baited = share(2);
    expect(baited.rare).toBeGreaterThan(plain.rare * 1.25);
    expect(baited.rare).toBeLessThan(plain.rare * 2.05); // < the full 2x: it skews, it does not replace
    expect(baited.rare).toBeLessThan(0.9);               // never a guaranteed rare fish
    expect(baited.top).toBeGreaterThan(0.05);            // the common fish are still there
    expect(baited.top).toBeLessThan(plain.top);
  });

  it('rareMul 1 / undefined leaves the roll bit-identical to before the shop existed', () => {
    const a = mulberry32(4), b = mulberry32(4);
    for (let i = 0; i < 300; i++) {
      expect(pickSpecies('Reef', { x: 0, z: 0 }, { hotspot: false, hump: null }, a))
        .toBe(pickSpecies('Reef', { x: 0, z: 0 }, { hotspot: false, hump: null, rareMul: undefined }, b));
    }
  });

  it('falls back to the other bait rather than leave a stocked box unused', () => {
    const onlyBally = buyAll(['tackle', 'bait-ballyhoo']);
    const flats = rigCast(onlyBally, 'Flats');
    expect(flats.bait).toBe('ballyhoo');
    expect(flats.rareMul).toBeLessThan(rigCast(onlyBally, 'Offshore').rareMul);
    const onlyShrimp = buyAll(['tackle', 'bait-shrimp']);
    expect(rigCast(onlyShrimp, 'Offshore').bait).toBe('shrimp');
  });
});

/* ------------------------------------------------------------------------------------------ *
 * leader.fluoro
 * ------------------------------------------------------------------------------------------ */
describe('leader.fluoro — fewer bite-offs on toothy fish', () => {
  it('is spent at the hookup and only when owned', () => {
    const inv = buyAll(['tackle', 'leader-fluoro']);
    expect(countOf(inv, FLUORO_KEY)).toBe(1);
    const a = rigLeader(inv);
    expect(a.fluoro).toBe(true); expect(countOf(a.inventory, FLUORO_KEY)).toBe(0);
    const b = rigLeader(a.inventory);
    expect(b.fluoro).toBe(false); expect(b.inventory).toBe(a.inventory);
  });

  it('halves chafe on toothy fish and trims it a little on the rest', () => {
    const t = tackleById(STARTER_TACKLE);
    const w0 = fightParamsFor('wahoo', 40, 3, t), w1 = fightParamsFor('wahoo', 40, 3, t, { fluoro: true });
    expect(w1.rough / w0.rough).toBeCloseTo(0.5, 9);
    const m0 = fightParamsFor('mahi', 20, 3, t), m1 = fightParamsFor('mahi', 20, 3, t, { fluoro: true });
    expect(m1.rough / m0.rough).toBeGreaterThan(0.7); expect(m1.rough / m0.rough).toBeLessThan(1);
  });

  it('measurably cuts leader-chafe break-offs on wahoo, and fluoro is not a cure-all', () => {
    // Chafe only decides long fights, so use the player who makes them: a timid one, loose drag,
    // light line (mono12). Measured over 300 wahoo: 72 frayed plain -> 0 with fluoro; the fish
    // that used to chafe through are now lost to hook wear instead, so total losses do not vanish.
    const run = (fluoro: boolean): { frayed: number; landed: number } => {
      const rng = mulberry32(31);
      let frayed = 0, landed = 0; const N = 300;
      for (let i = 0; i < N; i++) {
        const params = fightParamsFor('wahoo', 40 + 50 * rng(), 1, tackleById('mono12'), { fluoro });
        let s = startFight(params, BOAT.boatX + 35, BOAT.boatZ, rng); let t = 0, held = true, nx = 0;
        while (s.outcome === 'fighting' && t < 900) {
          if (t >= nx) { held = s.tension < 0.4 && !s.airborne; nx = t + 0.25; }
          s = stepFight(s, { reeling: held }, params, BOAT, rng, DT); t += DT;
        }
        if (s.outcome === 'frayed') frayed++;
        if (s.outcome === 'landed') landed++;
      }
      return { frayed: frayed / N, landed: landed / N };
    };
    const plain = run(false), fl = run(true);
    expect(plain.frayed).toBeGreaterThan(0.1);
    expect(fl.frayed).toBeLessThan(plain.frayed / 2);
    expect(fl.landed).toBeLessThan(0.8); // wahoo on 12 lb is still a gamble with fluoro
  });
});

/* ------------------------------------------------------------------------------------------ *
 * cooler.ice
 * ------------------------------------------------------------------------------------------ */
describe('cooler.ice — more room in the cooler', () => {
  it('adds ICE_BONUS_LB to the boat\'s COOLER_CAP, on top of any owned bonus', () => {
    for (const id of Object.keys(COOLER_CAP)) {
      expect(coolerCapFor(COOLER_CAP[id], NO_MODIFIERS, true)).toBe(COOLER_CAP[id] + ICE_BONUS_LB);
      expect(coolerCapFor(COOLER_CAP[id], NO_MODIFIERS, false)).toBe(COOLER_CAP[id]);
    }
    expect(coolerCapFor(150, { ...NO_MODIFIERS, coolerBonusLb: 25 }, true)).toBe(150 + 25 + ICE_BONUS_LB);
  });

  it('a bag is one unit and spendable', () => {
    const inv = buyAll(['tackle', 'ice-bag']);
    expect(countOf(inv, ICE_KEY)).toBe(1);
  });
});

/* ------------------------------------------------------------------------------------------ *
 * wiring seam
 * ------------------------------------------------------------------------------------------ */
describe('the GearPort seam', () => {
  it('reads mods from the inventory it holds and reflects commits', () => {
    const port = createGearPort(emptyInventory());
    expect(port.mods(0).spearRangeM).toBe(0);
    port.commit(buyAll(['guns', 'spear-long']));
    expect(port.mods(0).spearRangeM).toBe(6);
  });

  it('every item these two shops sell is covered above (guards against a new shelf item with no effect)', () => {
    const covered = new Set(['spear.long', 'spear.reel', 'spear.shafts', 'rod.heavy', 'rod.used', 'reel.lever',
      'bait.shrimp', 'bait.ballyhoo', 'leader.fluoro', 'cooler.ice',
      // the boat pistol's shelf items are covered in handgun.test.ts ("ammunition and the shop")
      'handgun.ammo', 'handgun.extmag', 'handgun.dot',
      // the marine flare kit: fired from the pistol grip, see handgun.test.ts "the marine flare"
      'safety.flare']);
    const mine = [...VENUES.guns.sells, ...VENUES.tackle.sells, ...VENUES.pawn.sells]
      .map((s) => s.effect.key);
    for (const k of mine) expect(covered.has(k), k).toBe(true);
    expect(SPECIES.wahoo).toBeDefined();
  });
});

