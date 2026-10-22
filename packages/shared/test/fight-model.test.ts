/**
 * The rebuilt fight model (sim/fight.ts "WHY THIS WAS REBUILT"): failure modes, the drag
 * trade-off, tackle, and a skill gradient. The statistical tests are Monte Carlo over a fixed seed,
 * so they are deterministic; the margins are deliberately wide so a retune that keeps the *shape*
 * of the model (not the third decimal of a constant) keeps passing. The full numbers live in
 * apps/client/test/playthrough-model.mjs.
 */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/rng/index.js';
import {
  DRAG_FRAC, dragFraction, fightParamsFor, rollWeight, startFight, stepFight,
  type FightEnv, type FightOutcome, type FightParams, type FightState,
} from '../src/sim/fight.js';
import { STARTER_TACKLE, TACKLE, tackleById } from '../src/content/tackle.js';
import { SPECIES, ZONE_TABLE } from '../src/content/species.js';

const DT = 1 / 30;
/** Open Gulf Stream water: no land within any run, so only the mechanics under test can end a fight. */
const BOAT: FightEnv = { boatX: -500, boatZ: 6000 };

type Policy = (s: FightState, p: FightParams) => boolean;
const holdDown: Policy = () => true;
/** Attentive angler: feather through jumps, never crank a fresh running fish, pump a resting one. */
const angler: Policy = (s) => {
  if (s.airborne) return s.tension < 0.12;
  if (s.tension > s.limit * 0.7) return false;
  if (s.running) return s.stam < 0.5 && s.tension < s.limit * 0.45;
  return s.tension < s.limit * 0.65;
};

function fight(key: string, weight: number, drag: number, rng: () => number, policy: Policy, tackleId = STARTER_TACKLE, react = 0.25) {
  const params = fightParamsFor(key, weight, drag, tackleById(tackleId));
  let s = startFight(params, BOAT.boatX + 35, BOAT.boatZ, rng);
  let t = 0, held = true, next = 0;
  while (s.outcome === 'fighting' && t < 900) {
    if (t >= next) { held = policy(s, params); next = t + react; }
    s = stepFight(s, { reeling: held }, params, BOAT, rng, DT);
    t += DT;
  }
  return { outcome: s.outcome as FightOutcome, t };
}

function rate(key: string, drag: number, n: number, seed: number, policy: Policy = angler, tackleId = STARTER_TACKLE, wLo = 0, wHi = 1) {
  const rng = mulberry32(seed);
  const S = SPECIES[key];
  let win = 0, secs = 0; const lose: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const w = S.min + (S.max - S.min) * (wLo + (wHi - wLo) * rng());
    const r = fight(key, w, drag, rng, policy, tackleId);
    if (r.outcome === 'landed') { win++; secs += r.t; } else lose[r.outcome] = (lose[r.outcome] ?? 0) + 1;
  }
  return { win: win / n, sec: secs / Math.max(1, win), lose };
}

/** A mid-fight state to poke at one mechanic. Far from every threshold so only the poked field matters. */
function midFight(params: FightParams, over: Partial<FightState> = {}): FightState {
  return {
    ...startFight(params, BOAT.boatX + 40, BOAT.boatZ, mulberry32(1)),
    running: false, runT: 99, shakeT: 99, shake: 0, tension: 0.3, stam: 0.6, dist: 40, ...over,
  };
}

describe('the fight is a contest, not a formality', () => {
  // These assert that SOMETHING contests the player's gear, which means naming a fish that is
  // actually a contest for the rung under test. Better tackle is supposed to trivialise the fish
  // below it and move the fight up the size scale, and it measurably does: hold-the-reel-down
  // beats a wahoo 68% of the time on mono30 and 100% on braid50, while against a tarpon in the
  // top 40% of its range it wins 0% on both. Pinning these to one species made them read as
  // "skill stopped mattering" the moment the starting rung moved, when what had happened is that
  // the contest moved to bigger fish.
  it('holding the reel down loses to a strong fish and to a trophy', () => {
    expect(rate('yellowfin', 3, 60, 11, holdDown, 'mono30', 0.3, 1).win).toBeLessThan(0.2);
    // ...and on the rung the player actually starts on, against a fish that rung has to work for.
    expect(rate('tarpon', 3, 60, 11, holdDown, STARTER_TACKLE, 0.6, 1).win).toBeLessThan(0.2);
  });

  it('an attentive player lands almost every ordinary fish on starter tackle', () => {
    for (const k of ['snook', 'redfish', 'mutton', 'hogfish']) expect(rate(k, 3, 60, 12).win).toBeGreaterThan(0.9);
  });

  it('skill is rewarded: attentive beats mashing on a fish that actually pulls', () => {
    // Light tackle: a wahoo is the contest.
    const a = rate('wahoo', 3, 80, 13, angler, 'mono30').win;
    const h = rate('wahoo', 3, 80, 13, holdDown, 'mono30').win;
    expect(a).toBeGreaterThan(h + 0.25);
    // Starter tackle: a wahoo no longer is, so the gap has to show on a bigger fish or the rung
    // has quietly become a formality.
    const aT = rate('tarpon', 3, 80, 14, angler, STARTER_TACKLE, 0.6, 1).win;
    const hT = rate('tarpon', 3, 80, 14, holdDown, STARTER_TACKLE, 0.6, 1).win;
    expect(aT).toBeGreaterThan(hT + 0.2);
  });

  it('a trophy on light tackle is a genuine event: neither a lock nor impossible with the right rig', () => {
    const light = rate('tarpon', 3, 80, 14, angler, 'mono30', 0.4, 1).win;
    const heavy = rate('tarpon', 3, 80, 14, angler, 'braid80', 0.4, 1).win;
    expect(light).toBeGreaterThan(0.02);
    expect(light).toBeLessThan(0.7);
    expect(heavy).toBeGreaterThan(light + 0.2);
  });

  it('a 900 lb bluefin is not landed on 30 lb line', () => {
    expect(rate('bluefin', 3, 40, 15, angler, 'mono30', 0.8, 1).win).toBeLessThan(0.05);
  });

  it('is pure and deterministic: same inputs and stream give the same fight, inputs untouched', () => {
    const p = fightParamsFor('cobia', 40, 3);
    const s0 = startFight(p, BOAT.boatX + 30, BOAT.boatZ, mulberry32(3));
    const frozen = JSON.stringify(s0);
    const a = stepFight(s0, { reeling: true }, p, BOAT, mulberry32(4), DT);
    const b = stepFight(s0, { reeling: true }, p, BOAT, mulberry32(4), DT);
    expect(a).toEqual(b);
    expect(JSON.stringify(s0)).toBe(frozen);
  });
});

describe('drag is a decision', () => {
  it('maps settings 1..5 to a strictly rising clutch, interpolating between', () => {
    for (let i = 1; i < DRAG_FRAC.length; i++) expect(DRAG_FRAC[i]).toBeGreaterThan(DRAG_FRAC[i - 1]);
    expect(dragFraction(1)).toBe(DRAG_FRAC[0]);
    expect(dragFraction(5)).toBe(DRAG_FRAC[4]);
    expect(dragFraction(2.5)).toBeCloseTo((DRAG_FRAC[1] + DRAG_FRAC[2]) / 2, 6);
    expect(dragFraction(99)).toBe(DRAG_FRAC[4]);
  });

  it('input.drag overrides params.drag, so turning the knob mid-fight changes the physics', () => {
    // A fish only modestly over the clutch: a monster saturates the slip rate at any setting.
    const p = fightParamsFor('tarpon', 80, 1);
    const run = midFight(p, { running: true, runT: 99, pull: p.str, tension: 0.2 });
    const loose = stepFight(run, { reeling: false, drag: 1 }, p, BOAT, mulberry32(1), 0.5);
    const tight = stepFight(run, { reeling: false, drag: 5 }, p, BOAT, mulberry32(1), 0.5);
    expect(tight.tension).toBeGreaterThan(loose.tension + 0.1);
    expect(loose.dist).toBeGreaterThan(tight.dist); // a loose clutch gives line
  });

  it('on a strong fish, tighter drag shortens the fight but trades pulled/spooled for snapped/frayed', () => {
    const lo = rate('bullshark', 1, 160, 21, angler, 'mono30', 0.1, 0.7);
    const hi = rate('bullshark', 5, 160, 21, angler, 'mono30', 0.1, 0.7);
    expect(hi.sec).toBeLessThan(lo.sec * 0.75);
    const breaks = (l: Record<string, number>) => (l.snapped ?? 0) + (l.frayed ?? 0);
    const slips = (l: Record<string, number>) => (l.pulled ?? 0) + (l.spooled ?? 0);
    expect(breaks(hi.lose)).toBeGreaterThan(breaks(lo.lose) + 15);
    expect(slips(lo.lose)).toBeGreaterThan(slips(hi.lose) + 15);
  });

  it('a jumper that is not strong (tarpon) rewards a tighter drag, a big shark punishes it: no setting dominates', () => {
    const tarpon = [1, 3, 5].map((d) => rate('tarpon', d, 120, 22, angler, 'mono30', 0.1, 0.6).win);
    const shark = [1, 3, 5].map((d) => rate('bullshark', d, 120, 22, angler, 'mono30', 0.05, 0.6).win);
    expect(tarpon[2]).toBeGreaterThan(tarpon[0] + 0.05); // 5 beats 1 for the tarpon
    expect(shark[1]).toBeGreaterThan(shark[2] + 0.1); // 3 beats 5 for the shark
    // opposite verdicts on 1 vs 5: neither extreme dominates
    expect(tarpon[2]).toBeGreaterThan(tarpon[0]);
    expect(shark[0]).toBeGreaterThan(shark[2] + 0.05);
  });

  it('a tight clutch makes the same shock land harder', () => {
    const p = fightParamsFor('yellowfin', 100, 3);
    const mag = (drag: number) => {
      let tot = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const s = midFight(p, { shakeT: 0.001, tension: 0.3 });
        for (const e of stepFight(s, { reeling: false, drag }, p, BOAT, mulberry32(seed), DT).events) if (e.type === 'shock') tot += e.mag;
      }
      return tot;
    };
    expect(mag(5)).toBeGreaterThan(mag(1) * 2);
  });
});

describe('failure modes an angler would recognise', () => {
  it('horsing: cranking a green running fish loads the line far more than cranking a tired one', () => {
    // Pinned to mono30: this measures a mechanic against a line rating, and tension is normalised
    // to that rating, so the margin shrinks on heavier line without the mechanic changing.
    const p = fightParamsFor('wahoo', 50, 3, tackleById('mono30'));
    const green = midFight(p, { running: true, pull: p.str, stam: 1, tension: 0.1 });
    const tired = midFight(p, { running: true, pull: p.str, stam: 0.15, tension: 0.1 });
    const g = stepFight(green, { reeling: true }, p, BOAT, mulberry32(2), 0.4).tension;
    const t = stepFight(tired, { reeling: true }, p, BOAT, mulberry32(2), 0.4).tension;
    expect(g).toBeGreaterThan(t + 0.1);
  });

  it('popping the leader: mashing the reel on a strong green fish parts the line', () => {
    const rng = mulberry32(31);
    let snaps = 0;
    for (let i = 0; i < 40; i++) {
      const r = fight('marlin', 300, 3, rng, holdDown);
      if (r.outcome === 'snapped' || r.outcome === 'frayed') snaps++;
    }
    expect(snaps).toBeGreaterThan(10);
  });

  it('slack during a jump throws the hook; a bowed (lightly loaded) line does not', () => {
    const p = fightParamsFor('mutton', 12, 3);
    const jump = (tension: number) => {
      let s = midFight(p, { airborne: true, airT: 99, tension, hookHold: 1 });
      for (let i = 0; i < 30 && s.outcome === 'fighting'; i++) s = stepFight({ ...s, tension }, { reeling: false }, p, BOAT, mulberry32(5), DT);
      return s.hookHold;
    };
    expect(jump(0.02)).toBeLessThan(jump(0.25) - 0.15);
  });

  it('hook pull gets likelier the longer the fight has gone', () => {
    const p = fightParamsFor('cobia', 40, 3);
    const loss = (t: number) => {
      const s = midFight(p, { t, hookHold: 1, tension: 0.3, running: true, runT: 99, pull: 0.5 });
      return 1 - stepFight(s, { reeling: false }, p, BOAT, mulberry32(8), 1).hookHold;
    };
    expect(loss(120)).toBeGreaterThan(loss(0) * 2);
  });

  it('leader chafe accumulates under load, never heals, and lowers the limit the line parts at', () => {
    const p = fightParamsFor('wahoo', 40, 3);
    let s = midFight(p, { running: true, runT: 99, pull: p.str, tension: 0.5, abrasion: 0 });
    const seen: number[] = [];
    for (let i = 0; i < 300 && s.outcome === 'fighting'; i++) {
      s = stepFight({ ...s, tension: 0.5, hookHold: 1, dist: 40 }, { reeling: false }, p, BOAT, mulberry32(i + 1), DT);
      seen.push(s.abrasion);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBeGreaterThan(0.1);
    expect(s.limit).toBeLessThan(0.95);
    expect(s.limit).toBeCloseTo(1 - 0.55 * s.abrasion, 6);
  });

  it('toothy fish chafe faster than smooth ones, and a heavier leader slows it', () => {
    const chafe = (key: string, tackleId: string) => {
      const p = fightParamsFor(key, SPECIES[key].max / 2, 3, tackleById(tackleId));
      const s = midFight(p, { running: true, runT: 99, pull: p.str, tension: 0.5, abrasion: 0 });
      return stepFight(s, { reeling: false }, p, BOAT, mulberry32(1), 5).abrasion;
    };
    expect(chafe('wahoo', 'mono30')).toBeGreaterThan(chafe('permit', 'mono30') * 1.5);
    expect(chafe('wahoo', 'mono12')).toBeGreaterThan(chafe('wahoo', 'braid80'));
  });

  it('spooling: a long run on a loose drag runs out of line', () => {
    const rng = mulberry32(41);
    let spooled = 0;
    for (let i = 0; i < 30; i++) if (fight('bluefin', 600, 1, rng, angler, 'mono30').outcome === 'spooled') spooled++;
    expect(spooled).toBeGreaterThan(3);
  });

  it('a green fish at the boat bolts instead of being landed; a tired one comes in', () => {
    const p = fightParamsFor('wahoo', 30, 3);
    const near = (stam: number) => midFight(p, { x: BOAT.boatX + 3, z: BOAT.boatZ, dist: 3, stam, running: false });
    const green = stepFight(near(0.9), { reeling: true }, p, BOAT, mulberry32(9), DT);
    expect(green.outcome).toBe('fighting');
    expect(green.running).toBe(true);
    const spent = stepFight(near(0.1), { reeling: true }, p, BOAT, mulberry32(9), DT);
    expect(spent.outcome).toBe('landed');
  });
});

describe('tackle', () => {
  it('the ladder is strictly stronger line each rung, and has a price for every rung', () => {
    for (let i = 1; i < TACKLE.length; i++) expect(TACKLE[i].lineLb).toBeGreaterThan(TACKLE[i - 1].lineLb);
    expect(tackleById('nonsense').id).toBe(STARTER_TACKLE);
    expect(tackleById(undefined).id).toBe(STARTER_TACKLE);
  });

  it('line class sets how many line-ratings a given fish pulls', () => {
    const pull = (id: string) => fightParamsFor('tarpon', 100, 3, tackleById(id)).pullN;
    expect(pull('mono12')).toBeGreaterThan(pull('mono30'));
    expect(pull('mono30')).toBeGreaterThan(pull('braid80'));
    expect(fightParamsFor('tarpon', 100, 3, tackleById('mono30')).ratingLb).toBe(30);
  });

  it('a heavier outfit lands more of the fish that matter', () => {
    const w = TACKLE.map((t) => rate('yellowfin', 3, 60, 51, angler, t.id, 0.2, 0.8).win);
    for (let i = 1; i < w.length; i++) expect(w[i]).toBeGreaterThanOrEqual(w[i - 1] - 0.05);
    expect(w[w.length - 1]).toBeGreaterThan(w[0] + 0.5);
  });

  it('thin line holds more yardage', () => {
    expect(fightParamsFor('tarpon', 80, 3, tackleById('mono12')).maxLine).toBeGreaterThan(fightParamsFor('tarpon', 80, 3, tackleById('braid130')).maxLine);
  });
});

describe('presentation hooks', () => {
  it('reports the clutch slipping on a strong run and holding on a weak one', () => {
    const strong = fightParamsFor('marlin', 300, 3);
    const weak = fightParamsFor('trout', 3, 3);
    const a = stepFight(midFight(strong, { running: true, pull: strong.str }), { reeling: false }, strong, BOAT, mulberry32(1), DT);
    const b = stepFight(midFight(weak, { running: true, pull: weak.str }), { reeling: false }, weak, BOAT, mulberry32(1), DT);
    expect(a.slipping).toBe(true);
    expect(b.slipping).toBe(false);
  });

  it('emits shock events on a bolt so the rod can kick', () => {
    const p = fightParamsFor('yellowfin', 100, 3);
    const s = midFight(p, { running: false, runT: 0.001 });
    const out = stepFight(s, { reeling: true }, p, BOAT, mulberry32(3), DT);
    expect(out.events.some((e) => e.type === 'shock')).toBe(true);
  });
});

describe('big fish are reachable and still earned', () => {
  const REEF = { x: -1150, z: 1500 };
  const GULF = { x: -500, z: 6000 };

  it('every zone-table species exists, and the big-game species sit in the zones they belong to', () => {
    for (const [zone, table] of Object.entries(ZONE_TABLE)) for (const [k] of table) expect(SPECIES[k], `${zone}: ${k}`).toBeDefined();
    const has = (zone: string, k: string) => ZONE_TABLE[zone].some(([s]) => s === k);
    for (const k of ['bluefin', 'marlin', 'swordfish', 'yellowfin']) expect(has('Offshore', k)).toBe(true);
    for (const k of ['wahoo', 'sailfish', 'marlin']) expect(has('Weedline', k)).toBe(true);
    for (const k of ['amberjack', 'cobia', 'yellowfin', 'goliath']) expect(has('Oil Rig', k)).toBe(true);
  });

  it('the weight roll uses the ceiling: far more top-of-range fish than the legacy rng^1.8 shape', () => {
    const rng = mulberry32(61);
    const n = 20000;
    let top = 0, max = 0;
    for (let i = 0; i < n; i++) {
      const w = rollWeight('grouper', REEF, false, rng);
      const t = (w - SPECIES.grouper.min) / (SPECIES.grouper.max - SPECIES.grouper.min);
      if (t >= 0.95) top++;
      max = Math.max(max, t);
      expect(w).toBeGreaterThanOrEqual(SPECIES.grouper.min);
      expect(w).toBeLessThanOrEqual(SPECIES.grouper.max);
    }
    // legacy: P(t >= .95) = 1 - .95^(1/1.8) ~ 2.8% inshore
    expect(top / n).toBeGreaterThan(0.037);
    expect(max).toBeGreaterThan(0.99);
  });

  it('hotspots grow the tail further', () => {
    const frac = (hot: boolean) => {
      const rng = mulberry32(62);
      let top = 0;
      for (let i = 0; i < 20000; i++) if ((rollWeight('amberjack', GULF, hot, rng) - 15) / 105 >= 0.9) top++;
      return top / 20000;
    };
    expect(frac(true)).toBeGreaterThan(frac(false));
  });

  it('a monster hooked on starter tackle is usually lost, and on heavy tackle usually landed', () => {
    const win = (tackleId: string) => rate('marlin', 3, 40, 71, angler, tackleId, 0.05, 0.3).win;
    expect(win('mono30')).toBeLessThan(0.1);
    expect(win('braid130')).toBeGreaterThan(win('mono30') + 0.2);
  });

  it('losing a monster on light tackle ends in a popped line, a pulled hook or a spooling', () => {
    const { lose } = rate('yellowfin', 3, 60, 72, angler, 'mono30', 0.85, 1);
    const losses = Object.values(lose).reduce((a, b) => a + b, 0);
    expect(losses).toBeGreaterThan(40);
    const earned = (lose.snapped ?? 0) + (lose.frayed ?? 0) + (lose.pulled ?? 0) + (lose.spooled ?? 0);
    expect(earned / losses).toBeGreaterThan(0.95);
  });
});
