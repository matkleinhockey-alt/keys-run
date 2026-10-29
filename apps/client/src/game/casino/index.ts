/**
 * Client glue for the Gaff & Gill Casino's slot machines. The rules are pure and shared
 * (packages/shared/src/sim/slots.ts for the odds, sim/reels.ts for the reel motion); this file owns
 * what they must not: localStorage, the wallet, the DOM panel, the canvas, the sound.
 *
 * ## The sequence that makes a spin impossible to re-roll
 * Taking a spin is one synchronous block, in this order:
 *   1. `debit(bet)`: the stake leaves the wallet (and the wallet is written to disk);
 *   2. `resolveSpin`: draws spin number n of this save, n+1 is stored, and the winnings are put in
 *      `pending` (sim/slots.ts);
 *   3. `save()`: the casino state is written to disk;
 *   4. only then do the reels move.
 * A reload, a closed tab, or Esc at any moment after step 1 finds a stake gone, a spin counted and
 * any win parked in `pending`, which is paid on the next load (`payPending`). There is no point at
 * which refreshing returns the stake or deals the same spin again. Rejected: debiting at the END of
 * the animation (a reload mid-spin would be a free look at the result) and drawing the spin from
 * the clock (lets a player time a click).
 *
 * ## Time
 * The reel animation is stepped with the same clamped dt (<= 0.05 s per rendered frame) as the main
 * loop, from this module's own rAF, the way game/services does for its fades, so a slow machine
 * plays the same spin more slowly instead of skipping the stop. The minimum gap between spins is
 * wall-clock (a player cannot beat it by closing and reopening the panel, which a sim clock that
 * only runs while the panel is open would allow).
 *
 * ## SERVER SEAM
 * Like the wallet and the scratch-off (game/services), the seed lives in the player's own
 * localStorage: this is not authoritative and nothing here reaches a leaderboard. Money-bearing play
 * for anyone but the player holding it would move `resolveSpin` and the wallet to the server.
 */
import {
  BET_LADDER, LINE_COUNT, MAX_BET, MIN_BET, MIN_SPIN_GAP_S, PAY_SHRIMP_PAIR, canSpin, createCasino, drawStops, paytableRows, payoutFor,
  resolveSpin, resultLine, sanitizeCasino, settle, slotOdds, winningLines, gridFor, type CasinoState, type SpinResult,
} from '@keysrun/shared/sim/slots';
import { createReels, type ReelSet } from '@keysrun/shared/sim/reels';
import { VENUES } from '@keysrun/shared/content/venues';
import { CABINETS, CABINET_THEMES } from '@keysrun/shared/world/casino';
import { buildStrips, paintSymbol, type Strips } from './art.js';
import { CAB_H, CAB_W, drawCabinet } from './render.js';
import './casino.css';
import { readSave, writeSave } from '../../net/cloud-save.js';

const STORAGE_KEY = 'keysrun.casino.v1';

function load(): CasinoState {
  const fresh = (): number => {
    try { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; } catch { return (Date.now() ^ 0x2545f491) >>> 0; }
  };
  try {
    const raw = readSave(STORAGE_KEY);
    return raw ? sanitizeCasino(JSON.parse(raw), fresh()) : createCasino(fresh());
  } catch {
    return createCasino(fresh());
  }
}
function save(s: CasinoState): void {
  try { writeSave(STORAGE_KEY, JSON.stringify(s)); } catch { /* unremembered, not fatal */ }
}

/** What the casino needs from the audio engine (a subset, so tests can pass a stub). */
export interface CasinoAudio {
  casinoReels(level: number, rate: number): void;
  casinoSpin(): void;
  casinoStop(reel: number): void;
  casinoWin(tier: 'push' | 'small' | 'big' | 'jackpot'): void;
  casinoDud(): void;
  casinoClick(): void;
  casinoAmbience(dt: number, level: number): void;
}

export interface CasinoDeps {
  economy: { state: { cash: number }; credit(n: number): void; debit(n: number): boolean; flush(): void };
  toast(msg: string): void;
  audio: CasinoAudio;
}

const $ = (id: string): HTMLElement | null => document.getElementById(id);
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const usd = (n: number): string => '$' + Math.round(n).toLocaleString('en-US');
const signed = (n: number): string => (n < 0 ? '-' : '+') + usd(Math.abs(n));

export function createCasinoSystem(deps: CasinoDeps) {
  let state = load();
  let open = false;
  let spot = 'cage';
  let onClose: (() => void) | null = null;
  let visits = 0;
  let strips: Strips | null = null;
  let reels: ReelSet | null = null;
  let current: SpinResult | null = null;
  let tease: number | null = null;
  let win: { lines: SpinResult['lines']; amount: number; kind: string; shown: number; age: number } | null = null;
  let session = 0;
  let raf = 0;
  let last = 0;
  let simT = 0;
  let lastSpinWall = -1e9;
  let message = '';
  let showPay = false;
  let canvas: HTMLCanvasElement | null = null;
  let g: CanvasRenderingContext2D | null = null;

  /** A win drawn but never paid because the page went away mid-spin: pay it now. */
  function payPending(announce: boolean): void {
    const r = settle(state);
    if (r.payout <= 0) return;
    state = r.state;
    deps.economy.credit(r.payout);
    deps.economy.flush();
    save(state);
    if (announce) deps.toast(`The casino pays out your last spin: ${usd(r.payout)}.`);
  }
  payPending(true);

  // ------------------------------------------------------------------------------------------ DOM
  function panel(): HTMLElement {
    let p = $('casinoPanel');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'casinoPanel';
    p.className = 'panel hidden';
    ($('hud') ?? document.body).append(p);
    p.addEventListener('click', onClick);
    return p;
  }

  function theme(): string {
    const c = CABINETS.find((q) => q.id === spot);
    return c ? CABINET_THEMES[c.theme] : 'Gaff & Gill';
  }

  function oddsHtml(): string {
    const o = slotOdds();
    const rows = paytableRows().map((r) => `<li><i class="cz-sym" data-sym="${r.symbol}"></i><b>${esc(r.label)}</b><span>${r.three ? `${r.three}x` : 'nothing'}</span><small>${esc(r.blurb)}</small></li>`).join('');
    return `<ul class="cz-paytable">${rows}</ul>`
      + `<p class="cz-odds">Three of a kind on any of <b>${LINE_COUNT} lines</b> (3 rows and both diagonals, always in play) pays the multiple above of your <b>line bet</b> (bet ÷ ${LINE_COUNT}). `
      + `Two shrimp from the left pay ${PAY_SHRIMP_PAIR}x. Bets $${MIN_BET}–$${MAX_BET}. `
      + `<b>Returns ${o.rtpPct}% over the long run</b> (the house keeps ${o.houseEdgePct}%): exact, counted over all ${o.combos.toLocaleString('en-US')} possible spins. `
      + `Something pays on ${(o.hitRate * 100).toFixed(0)}% of spins, you come out ahead on ${(o.profitRate * 100).toFixed(0)}%, the marlin comes up about once in ${o.oneInJackpot.toLocaleString('en-US')}. Top prize ${o.maxMult}x your bet.</p>`;
  }

  function render(): void {
    const p = panel();
    const greeting = VENUES.casino.greeting[visits % VENUES.casino.greeting.length];
    const cash = deps.economy.state.cash;
    if (spot === 'cage') {
      const net = state.won - state.wagered;
      p.innerHTML = `<h2>The Change Booth</h2><div class="vtag">${esc(VENUES.casino.tagline)}</div>`
        + `<p class="say">“${esc(greeting)}”</p>`
        + `<p class="blurb">${esc(VENUES.casino.blurb)}</p>`
        + `<div class="cz-ledger"><div><small>Spins</small><b>${state.spins.toLocaleString('en-US')}</b></div><div><small>Wagered</small><b>${usd(state.wagered)}</b></div><div><small>Paid out</small><b>${usd(state.won)}</b></div><div><small>Your net</small><b class="${net < 0 ? 'neg' : 'pos'}">${signed(net)}</b></div><div><small>Best win</small><b>${usd(state.best)}</b></div></div>`
        + `<h3>House rules and odds</h3>${oddsHtml()}`
        + `<p class="cz-fine">The cashier points out that the sign is not decoration. The house keeps ${slotOdds().houseEdgePct} cents of every dollar, which is why the fish pay better.</p>`
        + `<div class="foot"><span></span><b class="wallet">Cash ${usd(cash)}</b><button type="button" data-act="close">Back to the floor</button></div>`;
      paintSymbols(p);
      return;
    }
    const betBtns = BET_LADDER.map((b) => `<button type="button" class="cz-bet${b === state.bet ? ' on' : ''}${b > cash ? ' poor' : ''}" data-bet="${b}">${b === MAX_BET ? 'MAX ' : ''}$${b}</button>`).join('');
    p.innerHTML = `<div class="cz-head"><span class="cz-rtp">PAYS ${slotOdds().rtpPct}% · ${LINE_COUNT} LINES · $${MIN_BET}–$${MAX_BET}</span><button type="button" class="cz-x" data-act="close" aria-label="Walk away">✕</button></div>`
      + `<canvas id="czCanvas" width="${CAB_W}" height="${CAB_H}"></canvas>`
      + `<div class="cz-result" id="czResult">${esc(message || greeting)}</div>`
      + `<div class="cz-bets">${betBtns}</div>`
      + `<div class="cz-row"><button type="button" class="cz-spin" id="czSpin" data-act="spin">SPIN</button></div>`
      + `<div class="foot"><span id="czSession">${session === 0 ? '' : `This visit ${signed(session)}`}</span><b class="wallet" id="czCash">Cash ${usd(cash)}</b><button type="button" data-act="pay">${showPay ? 'Hide' : 'Paytable'}</button></div>`
      + `<div class="cz-pay${showPay ? '' : ' hidden'}">${oddsHtml()}</div>`
      + `<div class="cz-keys">Space spin / stop · ←→ bet · Esc walk away</div>`;
    canvas = $('czCanvas') as HTMLCanvasElement;
    g = canvas.getContext('2d');
    if (g) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(CAB_W * dpr); canvas.height = Math.round(CAB_H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    paintSymbols(p);
    paint();
  }

  /** The little fish icons in the paytable, drawn with the same painter as the reels. */
  function paintSymbols(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>('.cz-sym').forEach((el) => {
      const c = document.createElement('canvas'); c.width = 72; c.height = 48; c.style.width = '36px'; c.style.height = '24px';
      const cg = c.getContext('2d');
      if (!cg) return;
      cg.translate(36, 24); cg.scale(0.62, 0.62);
      paintSymbol(cg, el.dataset.sym as never, 1);
      el.replaceChildren(c);
    });
  }

  function paint(): void {
    if (!open || !g || spot === 'cage') return;
    if (!strips) strips = buildStrips(Math.min(1.5, window.devicePixelRatio || 1));
    drawCabinet(g, { t: simT, strips, theme: theme(), rest: state.stops, reels, tease, win, bet: state.bet });
  }

  function setResult(text: string, cls = ''): void {
    message = text;
    const r = $('czResult');
    if (r) { r.textContent = text; r.className = `cz-result ${cls}`; }
  }
  function refreshCash(): void {
    const c = $('czCash'); if (c) c.textContent = `Cash ${usd(deps.economy.state.cash)}`;
    const s = $('czSession'); if (s) s.textContent = session === 0 ? '' : `This visit ${signed(session)}`;
    document.querySelectorAll<HTMLElement>('.cz-bet').forEach((b) => b.classList.toggle('poor', Number(b.dataset.bet) > deps.economy.state.cash));
  }

  // ------------------------------------------------------------------------------------------ the spin
  function spin(): void {
    if (reels) { // a second press while spinning is a slam stop, once the reels have properly started
      if (reels.t > 0.6) reels.slam();
      return;
    }
    const wall = (performance.now() - lastSpinWall) / 1000;
    const why = canSpin(state.bet, deps.economy.state.cash, wall, state.pending);
    if (why) { setResult(why, 'bad'); deps.audio.casinoClick(); return; }
    // 1. stake out, 2. draw, 3. persist — all before the reels move (see the header)
    if (!deps.economy.debit(state.bet)) { setResult('The till jammed. Try again.', 'bad'); return; }
    const before = state;
    const r = resolveSpin(state, state.bet);
    state = r.state;
    save(state);
    lastSpinWall = performance.now();
    session -= r.result.bet;
    current = r.result; win = null;
    reels = createReels(before.stops, r.result.stops, r.result.tease);
    tease = r.result.tease;
    message = ''; setResult('…');
    deps.audio.casinoSpin();
    refreshCash();
    const sb = $('czSpin'); if (sb) sb.textContent = 'STOP';
    startLoop();
  }

  /** Reels have all come to rest (or the panel was closed): pay, announce, celebrate. */
  function finish(quiet: boolean): void {
    const res = current;
    reels = null; tease = null;
    const paid = settle(state);
    state = paid.state;
    if (paid.payout > 0) { deps.economy.credit(paid.payout); deps.economy.flush(); }
    save(state);
    deps.audio.casinoReels(0, 0);
    if (!res) return;
    session += paid.payout;
    current = null;
    if (!quiet) {
      setResult(resultLine(res), res.win > res.bet ? 'win' : res.win > 0 ? 'push' : '');
      if (res.win > 0) {
        win = { lines: res.lines, amount: res.win, kind: res.kind, shown: 0, age: 0 };
        deps.audio.casinoWin(res.kind === 'none' ? 'push' : res.kind);
      } else if (res.grid.flat().filter((s) => s === 5).length >= 3) deps.audio.casinoDud();
    }
    refreshCash();
    const sb = $('czSpin'); if (sb) sb.textContent = 'SPIN';
  }

  function frame(now: number): void {
    raf = 0;
    if (!open) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    simT += dt;
    if (reels) {
      reels.step(dt);
      let speedSum = 0;
      for (let i = 0; i < 3; i++) speedSum += reels.phase(i) === 'stopped' ? 0 : reels.speed(i);
      deps.audio.casinoReels(speedSum > 1 ? Math.min(1, speedSum / 40) : 0, speedSum / 60);
      for (const e of reels.drain()) if (e.kind === 'thunk') deps.audio.casinoStop(e.reel);
      if (reels.done) finish(false);
    } else if (win) {
      win.age += dt;
      win.shown = Math.min(win.amount, win.amount * Math.min(1, win.age / 0.9));
    }
    paint();
    if (reels || win) raf = requestAnimationFrame(frame);
  }
  function startLoop(): void {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------------------------------ input
  function setBet(b: number): void {
    if (!BET_LADDER.includes(b) || reels) return;
    state = { ...state, bet: b };
    save(state);
    deps.audio.casinoClick();
    document.querySelectorAll<HTMLElement>('.cz-bet').forEach((el) => el.classList.toggle('on', Number(el.dataset.bet) === b));
    paint();
  }

  function onClick(e: MouseEvent): void {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act],[data-bet]');
    if (!t) return;
    if (t.dataset.bet) { setBet(Number(t.dataset.bet)); return; }
    switch (t.dataset.act) {
      case 'spin': spin(); break;
      case 'close': api.close(); break;
      case 'pay': showPay = !showPay; deps.audio.casinoClick(); render(); break;
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (!open) return;
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); e.stopPropagation(); if (spot !== 'cage') spin(); return; }
    if (spot !== 'cage' && (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
      e.preventDefault(); e.stopPropagation();
      const i = BET_LADDER.indexOf(state.bet) + (e.code === 'ArrowLeft' || e.code === 'ArrowDown' ? -1 : 1);
      setBet(BET_LADDER[Math.max(0, Math.min(BET_LADDER.length - 1, i))]);
      return;
    }
    const d = /^Digit([1-5])$/.exec(e.code);
    if (d && spot !== 'cage') { e.stopPropagation(); setBet(BET_LADDER[Number(d[1]) - 1]); }
  }

  // ------------------------------------------------------------------------------------------ API
  const api = {
    /** Open the machine (`cabinet id`) or the change booth (`'counter-casino'`). `done` runs when it closes. */
    open(id: string, done: () => void): void {
      spot = id === 'counter-casino' ? 'cage' : id;
      onClose = done;
      open = true; visits++; showPay = false; session = 0; message = '';
      const p = panel();
      p.classList.remove('hidden');
      window.addEventListener('keydown', onKey, true);
      render();
      if (spot !== 'cage') { startLoop(); }
    },
    /** Esc / F / walking away. A spin in flight is settled at once: its result was fixed when it began. */
    close(): void {
      if (!open) return;
      if (reels) finish(true);
      open = false;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      window.removeEventListener('keydown', onKey, true);
      deps.audio.casinoReels(0, 0);
      $('casinoPanel')?.classList.add('hidden');
      const cb = onClose; onClose = null;
      cb?.();
    },
    isOpen: () => open,
    /** Per frame from land mode: how much of the room's sound to hear (0 outside, 1 on the floor). */
    ambience(dt: number, level: number): void { deps.audio.casinoAmbience(dt, level); },
    get state() { return state; },
  };

  // DEV / VERIFICATION HOOK ONLY (same spirit as __shopDebug): nothing in normal play calls it.
  // `seek` jumps the spin counter to the next spin that produces the wanted kind so a screenshot
  // harness does not have to burn thousands of spins to see a win; it is exactly what a player
  // cannot do, which is why it is only here.
  (window as unknown as { __casinoDebug?: unknown }).__casinoDebug = {
    state: () => ({ ...state }),
    open: (id: string) => api.open(id, () => {}),
    close: () => api.close(),
    spin: () => spin(),
    bet: (b: number) => setBet(b),
    /** Advance the animation by simulated seconds without waiting on rAF. */
    advance(sec: number): void {
      for (let t = 0; t < sec; t += 0.05) {
        simT += 0.05;
        if (reels) {
          reels.step(0.05);
          for (const e of reels.drain()) if (e.kind === 'thunk') deps.audio.casinoStop(e.reel);
          if (reels.done) finish(false);
        } else if (win) { win.age += 0.05; win.shown = Math.min(win.amount, win.amount * Math.min(1, win.age / 0.9)); }
      }
      paint();
    },
    seek(kind: 'none' | 'push' | 'small' | 'big' | 'jackpot'): number {
      for (let n = state.spins; n < state.spins + 2_000_000; n++) {
        const stops = drawStops(state.seed, n);
        const w = payoutFor(stops, state.bet);
        const k = w === 0 ? 'none' : winningLines(gridFor(stops)).some((l) => l.symbol === 'marlin') ? 'jackpot' : w >= state.bet * 20 ? 'big' : w > state.bet ? 'small' : 'push';
        if (k === kind) { state = { ...state, spins: n }; save(state); return n; }
      }
      return -1;
    },
    min: MIN_SPIN_GAP_S,
    resetGap: () => { lastSpinWall = -1e9; },
  };
  return api;
}

export type CasinoSystem = ReturnType<typeof createCasinoSystem>;
