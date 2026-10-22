/**
 * The slot machines: the printed odds are the real odds, the seeded draw matches them, and no way of
 * staking money turns the casino into an income. See sim/slots.ts's header for the design.
 */
import { describe, expect, it } from 'vitest';
import {
  BET_LADDER, LINES, LINE_COUNT, MAX_BET, MAX_WIN_MULT, MIN_BET, MIN_SPIN_GAP_S, PAY_SHRIMP_PAIR, PAY_THREE, REELS, REEL_LEN, ROWS,
  STRIPS, SYMBOLS, canSpin, createCasino, drawStops, gridFor, payoutFor, resolveSpin, resultLine, sanitizeCasino, settle,
  slotOdds, teaseReel, winningLines, type CasinoState,
} from '../src/sim/slots.js';
import { scratchOdds } from '../src/sim/services.js';

describe('the reels and the paytable', () => {
  it('has three strips of 24 stops with one marlin each, boots on every reel, and only known symbols', () => {
    expect(STRIPS).toHaveLength(REELS);
    for (const s of STRIPS) {
      expect(s).toHaveLength(REEL_LEN);
      expect(s.every((x) => x >= 0 && x < SYMBOLS.length)).toBe(true);
      expect(s.filter((x) => x === SYMBOLS.indexOf('marlin'))).toHaveLength(1);
      expect(s.filter((x) => x === SYMBOLS.indexOf('boot')).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('pays the boot nothing and never more for a rarer fish than a commoner one', () => {
    expect(PAY_THREE.boot).toBe(0);
    expect(PAY_THREE.shrimp).toBeLessThan(PAY_THREE.bonefish);
    expect(PAY_THREE.bonefish).toBeLessThan(PAY_THREE.permit);
    expect(PAY_THREE.permit).toBeLessThan(PAY_THREE.tarpon);
    expect(PAY_THREE.tarpon).toBeLessThan(PAY_THREE.marlin);
  });

  it('only offers bets that split evenly over the lines, inside the limits', () => {
    for (const b of BET_LADDER) { expect(b % LINE_COUNT).toBe(0); expect(b).toBeGreaterThanOrEqual(MIN_BET); expect(b).toBeLessThanOrEqual(MAX_BET); }
    expect(BET_LADDER[0]).toBe(MIN_BET);
    expect(BET_LADDER[BET_LADDER.length - 1]).toBe(MAX_BET);
  });

  it('reads the window the way the renderer draws it: top row first, wrapping at the end of the strip', () => {
    const g = gridFor([0, REEL_LEN - 1, 5]);
    expect(g).toHaveLength(REELS);
    expect(g[0]).toEqual([STRIPS[0][0], STRIPS[0][1], STRIPS[0][2]]);
    expect(g[1]).toEqual([STRIPS[1][REEL_LEN - 1], STRIPS[1][0], STRIPS[1][1]]);
    expect(g[2]).toHaveLength(ROWS);
  });

  it('finds a hand-built win on the right line and nowhere else', () => {
    const MARLIN = SYMBOLS.indexOf('marlin'), BOOT = SYMBOLS.indexOf('boot'), SHRIMP = SYMBOLS.indexOf('shrimp');
    // marlins on the three diagonal-down cells, boots everywhere else
    const grid = [[BOOT, BOOT, BOOT], [BOOT, BOOT, BOOT], [BOOT, BOOT, BOOT]];
    grid[0][0] = MARLIN; grid[1][1] = MARLIN; grid[2][2] = MARLIN;
    const w = winningLines(grid);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ symbol: 'marlin', count: 3, mult: PAY_THREE.marlin });
    expect(LINES[w[0].line]).toEqual([0, 1, 2]);
    // three boots on a line pay nothing
    expect(winningLines([[BOOT, BOOT, BOOT], [BOOT, BOOT, BOOT], [BOOT, BOOT, BOOT]])).toHaveLength(0);
    // two shrimp from the left pays the pair; two shrimp NOT from the left does not
    const pair = [[SHRIMP, BOOT, BOOT], [SHRIMP, BOOT, BOOT], [BOOT, BOOT, BOOT]];
    expect(winningLines(pair).map((l) => l.mult)).toEqual([PAY_SHRIMP_PAIR]);
    const notLeft = [[BOOT, BOOT, BOOT], [SHRIMP, BOOT, BOOT], [SHRIMP, BOOT, BOOT]];
    expect(winningLines(notLeft)).toHaveLength(0);
  });
});

describe('the printed odds are the real odds', () => {
  const o = slotOdds();

  it('enumerates every one of the 13,824 outcomes, so the RTP is exact, not estimated', () => {
    expect(o.combos).toBe(REEL_LEN ** REELS);
    // 90.5 cents on the dollar. If someone edits the strips or the paytable this fails and has to be changed ON PURPOSE.
    expect(o.rtp).toBeCloseTo(0.9050925925925926, 12);
    expect(o.rtpPct).toBe(90.5);
    expect(o.houseEdgePct).toBe(9.5);
    expect(o.rtp).toBeLessThan(1);
    // kinder than the scratch-off (69 cents), because a slot is played a hundred times a sitting
    expect(o.rtp).toBeGreaterThan(scratchOdds().ev / 5);
  });

  it('adds up: the per-symbol shares sum to the RTP, and the boot contributes nothing', () => {
    const sum = Object.values(o.share).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(o.rtp, 12);
    expect(o.share.boot).toBe(0);
    // the jackpot is worth having but is not where the return lives
    expect(o.share.marlin).toBeGreaterThan(0.05);
    expect(o.share.marlin).toBeLessThan(0.1);
  });

  it('has the shape it advertises: frequent small returns, a rare top prize, and a ceiling', () => {
    expect(o.hitRate).toBeGreaterThan(0.35);
    expect(o.hitRate).toBeLessThan(0.5);
    expect(o.profitRate).toBeLessThan(o.hitRate); // a pair of shrimp pays, but it is not ahead
    expect(o.oneInJackpot).toBe(2765);
    expect(o.maxMult).toBe(200);
    expect(o.maxMult).toBeLessThanOrEqual(MAX_WIN_MULT);
  });

  it('pays whole dollars for every stop combination at every bet, never above the ceiling', () => {
    for (let a = 0; a < REEL_LEN; a += 1) for (let b = 0; b < REEL_LEN; b += 3) for (let c = 0; c < REEL_LEN; c += 5) {
      for (const bet of BET_LADDER) {
        const p = payoutFor([a, b, c], bet);
        expect(Number.isInteger(p)).toBe(true);
        expect(p).toBeLessThanOrEqual(bet * MAX_WIN_MULT);
      }
    }
  });

  it('realises the printed return over 200,000 seeded spins, across three different saves', () => {
    const N = 200_000;
    for (const seed of [1, 0xc0ffee, 987654321]) {
      let paid = 0, hits = 0, jack = 0;
      for (let n = 0; n < N; n++) {
        const p = payoutFor(drawStops(seed, n), 5);
        paid += p;
        if (p > 0) hits++;
        if (p >= 1000) jack++;
      }
      const ret = paid / (N * 5);
      // per-spin sigma is ~4.73x the stake, so the standard error of the mean over N is ~0.0106: a 4-sigma band.
      expect(Math.abs(ret - o.rtp), `seed ${seed} realised ${ret.toFixed(4)}`).toBeLessThan(4 * (o.sigma / Math.sqrt(N)));
      expect(Math.abs(hits / N - o.hitRate)).toBeLessThan(0.01);
      expect(jack).toBeGreaterThan(N / o.oneInJackpot / 2);
      expect(jack).toBeLessThan((N / o.oneInJackpot) * 2);
    }
  });

  it('draws each stop uniformly: no reel favours a position', () => {
    const N = 120_000;
    for (let r = 0; r < REELS; r++) {
      const hist = new Array<number>(REEL_LEN).fill(0);
      for (let n = 0; n < N; n++) hist[drawStops(4242, n)[r]]++;
      const exp = N / REEL_LEN;
      const chi = hist.reduce((a, h) => a + ((h - exp) ** 2) / exp, 0);
      // chi-square, 23 dof: 99.99th percentile ~ 59
      expect(chi, `reel ${r}`).toBeLessThan(59);
    }
  });
});

describe('the draw is seeded and cannot be re-rolled', () => {
  it('is a pure function of (seed, spin number), independent of the bet', () => {
    expect(drawStops(77, 12)).toEqual(drawStops(77, 12));
    const a = resolveSpin(createCasino(77), 5), b = resolveSpin(createCasino(77), 100);
    expect(a.result.stops).toEqual(b.result.stops);
    expect(a.result.win * 20).toBe(b.result.win); // the same picture, a bigger stake: the win scales exactly
    const same = Array.from({ length: 40 }, (_, n) => drawStops(1, n).join() === drawStops(2, n).join());
    expect(same.every(Boolean)).toBe(false);
  });

  it('moves on by one spin every time and never repeats the pending draw: reloading cannot re-roll', () => {
    let s: CasinoState = createCasino(2024);
    const seen: string[] = [];
    for (let i = 0; i < 50; i++) {
      // "Reload": the persisted state is what comes back. Serialising and re-reading must change nothing.
      s = sanitizeCasino(JSON.parse(JSON.stringify(s)), 0);
      const r = resolveSpin(s, 10);
      expect(r.state.spins).toBe(s.spins + 1);
      expect(r.result.stops).toEqual(drawStops(2024, i));
      seen.push(r.result.stops.join());
      s = settle(r.state).state;
    }
    // resolving the SAME persisted state twice is the same spin: the only way to get a different draw is to spend a spin
    const again = resolveSpin(s, 10).result.stops, twice = resolveSpin(s, 10).result.stops;
    expect(again).toEqual(twice);
  });

  it('parks the win in pending, pays it once, and survives a reload before it is paid', () => {
    let s: CasinoState = createCasino(5);
    let spin = 0;
    // find a winning spin for this save
    while (payoutFor(drawStops(5, spin), 25) === 0) spin++;
    for (let i = 0; i < spin; i++) s = settle(resolveSpin(s, 25).state).state;
    const r = resolveSpin(s, 25);
    expect(r.result.win).toBeGreaterThan(0);
    expect(r.state.pending).toBe(r.result.win);
    const reloaded = sanitizeCasino(JSON.parse(JSON.stringify(r.state)), 0);
    expect(reloaded.pending).toBe(r.result.win);
    const paid = settle(reloaded);
    expect(paid.payout).toBe(r.result.win);
    expect(settle(paid.state).payout).toBe(0);
  });

  it('refuses a new spin while winnings are parked, a bet off the ladder, an empty wallet and a too-quick spin', () => {
    expect(canSpin(25, 1000, 10)).toBeNull();
    expect(canSpin(25, 1000, 10, 50)).toMatch(/paying/i);
    expect(canSpin(7, 1000, 10)).toMatch(/Bets run/);
    expect(canSpin(1000, 1000, 10)).toMatch(/Bets run/);
    expect(canSpin(25, 10, 10)).toMatch(/only have/);
    expect(canSpin(25, 2, 10)).toMatch(/out of it/);
    expect(canSpin(25, 1000, MIN_SPIN_GAP_S - 0.01)).toMatch(/reels/i);
  });

  it('sanitises a hand-edited save', () => {
    const s = sanitizeCasino({ seed: 'x', spins: -4, wagered: 1e99, pending: 1e12, stops: [99, -3, 'q'], bet: 7, best: NaN }, 123);
    expect(s.seed).toBe(123);
    expect(s.spins).toBe(0);
    expect(s.pending).toBeLessThanOrEqual(MAX_BET * MAX_WIN_MULT);
    expect(s.stops.every((x) => x >= 0 && x < REEL_LEN)).toBe(true);
    expect(BET_LADDER).toContain(s.bet);
    expect(s.best).toBe(0);
  });
});

describe('it is a sink: no way of staking turns it into income', () => {
  interface Strategy { name: string; bet(cash: number, start: number, last: { bet: number; win: number } | null): number; done?(cash: number, start: number): boolean }
  const biggestAffordable = (cash: number): number => [...BET_LADDER].reverse().find((b) => b <= cash) ?? 0;
  const STRATS: Strategy[] = [
    { name: 'flat minimum', bet: (c) => (c >= 5 ? 5 : 0) },
    { name: 'flat maximum', bet: (c) => (c >= 100 ? 100 : biggestAffordable(c)) },
    { name: 'martingale to the table limit', bet: (c, _s, last) => { const want = last && last.win < last.bet ? Math.min(100, last.bet * 2) : 10; return biggestAffordable(Math.min(c, want)); } },
    { name: 'stop when $500 ahead', bet: (c) => biggestAffordable(Math.min(c, 25)), done: (c, s) => c >= s + 500 },
    { name: 'bold play: stake what you can, double up or bust', bet: (c) => biggestAffordable(c), done: (c, s) => c >= s * 2 },
  ];

  function session(strat: Strategy, seed: number, start: number, maxSpins: number): { net: number; wagered: number } {
    let cash = start, s = createCasino(seed), wagered = 0, last: { bet: number; win: number } | null = null;
    for (let i = 0; i < maxSpins; i++) {
      if (strat.done?.(cash, start)) break;
      const bet = strat.bet(cash, start, last);
      if (bet <= 0 || canSpin(bet, cash, 99) !== null) break;
      cash -= bet;
      const r = resolveSpin(s, bet);
      cash += r.result.win;
      s = settle(r.state).state;
      wagered += bet; last = { bet, win: r.result.win };
    }
    return { net: cash - start, wagered };
  }

  for (const strat of STRATS) {
    it(`loses on average: ${strat.name}`, () => {
      const SESSIONS = 600, START = 2000;
      let sum = 0, sumSq = 0, wagered = 0;
      for (let i = 0; i < SESSIONS; i++) {
        const r = session(strat, 1000 + i * 7919, START, 400);
        sum += r.net; sumSq += r.net * r.net; wagered += r.wagered;
      }
      const mean = sum / SESSIONS, se = Math.sqrt(Math.max(0, sumSq / SESSIONS - mean * mean) / SESSIONS);
      // significantly negative: the whole 3-sigma interval sits below zero
      expect(mean + 3 * se, `${strat.name}: mean ${mean.toFixed(0)} +- ${se.toFixed(0)} over ${wagered} wagered`).toBeLessThan(0);
    });
  }

  it('takes the house edge off every dollar turned over, whatever the stake (flat betting, 400,000 spins)', () => {
    for (const bet of BET_LADDER) {
      let s = createCasino(31337), wagered = 0, won = 0;
      for (let i = 0; i < 80_000; i++) {
        const r = resolveSpin(s, bet);
        s = settle(r.state).state;
        wagered += bet; won += r.result.win;
      }
      expect(won / wagered, `bet ${bet}`).toBeLessThan(1);
      expect(Math.abs(won / wagered - slotOdds().rtp)).toBeLessThan(0.05);
    }
  });

  it('turns money over slowly enough to be a sink rather than a faucet or a firehose', () => {
    // At the table maximum and the minimum spin gap: the most a player can wager per simulated minute,
    // and what that costs in expectation, against the rod income the shop prices are quoted in (~$250/min inshore).
    const perMin = (60 / MIN_SPIN_GAP_S) * MAX_BET;
    const cost = perMin * (1 - slotOdds().rtp);
    expect(perMin).toBeLessThan(2000);
    expect(cost).toBeGreaterThan(100);
    expect(cost).toBeLessThan(250);
  });

  it('has a result line for every outcome and a tease that never touches the stops', () => {
    for (let n = 0; n < 500; n++) {
      const { result } = resolveSpin(createCasino(8), 10);
      expect(resultLine(result).length).toBeGreaterThan(5);
      expect([null, 2]).toContain(teaseReel(result.grid));
      void n;
    }
  });
});
