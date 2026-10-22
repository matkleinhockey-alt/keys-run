/**
 * Reel physics: spin-up, constant spin, an eased stop with a small overshoot, a settle. Pure,
 * closed-form, no dependencies. Written here on purpose rather than imported from a slot library
 * (see the header of ./slots.ts for why: it is forty lines of maths, and the payout curve is the
 * part that must be tuned to this game's economy).
 *
 * ## What makes a slot feel like a slot (and what each knob does)
 *   - Wind-up: a reel drags BACKWARD a little before it goes, like a mechanical drum taking up slack.
 *   - Spin-up: velocity rises on a smoothstep over `SPIN_UP_S`, not a step.
 *   - Cruise: constant `CRUISE` symbols per second. At 3 fps a frame covers ~7 symbols, so the picture
 *     is a blur by construction; the renderer draws the blur, this module only supplies the position.
 *   - STAGGER: the reels stop one after another, `STAGGER_S` apart, left to right. This is most of
 *     the feeling; three reels stopping together read as a screen refresh.
 *   - EASED STOP: the last `STOP_RUN` symbols are a cubic (quartic for a tease) ease-out whose INITIAL
 *     velocity equals the cruise velocity, so there is no visible change of speed where the stop
 *     begins and the reel bleeds off speed smoothly into a long, slow final roll onto the symbol.
 *   - OVERSHOOT + SETTLE: the ease-out ends `OVERSHOOT` of a symbol past the line, then the reel
 *     rolls back on a smoothstep to land exactly. The "thunk" event fires at the overshoot.
 *   - TEASE (near-miss): see `teaseReel` in slots.ts. A teased reel stops later, slower and over a
 *     longer run. It changes presentation only; the stop it lands on was drawn before it moved.
 *
 * ## The reel is a virtual strip (why timing never depends on the draw)
 * The first version made the reel travel on to the next place on the real strip where the drawn stop
 * came up. That ties the length of the stop to the draw: a stop one position behind the reel's
 * current place needed a 24-symbol run, over four seconds, and the reels stopped out of order
 * (found by the test that asserts left-to-right). Real video slots solve it the other way round and
 * so does this: every spin follows the SAME schedule, and the symbols that scroll through the window
 * for the last few positions are laid out so the drawn stop is what arrives. While the reel is at
 * cruising speed (a blur, 20 symbols a second) the picture is re-mapped once, invisibly, onto a
 * strip that ends at the stop (`ySwitch`). It never changes WHICH stop lands, only what streams
 * past on the way there; the stop is a fixed input and the outcome table is the real strip
 * (see ./slots.ts, `slotOdds`).
 *
 * ## Determinism
 * Position is a pure function of time since the spin began: `createReels` precomputes each reel's
 * timeline and `positionAt` evaluates it. There is no integration, so the result is identical at 3
 * fps and at 60 fps, and a test can sample it at any dt the harness clamps to (0.05 s) and still
 * land on the exact stop.
 *
 * ## Coordinates
 * `y` is distance travelled along the spin direction, in symbols, from the resting stop `from`. Symbols
 * move DOWN the window as `y` grows. `topIndex` converts to the strip index at the top row.
 */
import { REEL_LEN, REELS } from './slots.js';

export const SPIN_UP_S = 0.38;
/** Symbols per second at full speed. */
export const CRUISE = 20;
/** Seconds from the start of the spin to the first reel beginning to stop. */
export const FIRST_STOP_S = 1.05;
export const STAGGER_S = 0.52;
/** Extra wait before a teased reel starts to stop. */
export const TEASE_EXTRA_S = 0.9;
/** Symbols a normal / teased stop takes to bleed off speed. FIXED, so the timing of a spin never
 * depends on which stop was drawn. */
export const STOP_RUN = 5;
export const TEASE_RUN = 8;
export const OVERSHOOT = 0.16;
export const SETTLE_S = 0.24;
const WINDUP_S = 0.16;
const WINDUP_DIST = 0.22;

const smooth = (t: number): number => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };
const wrap = (i: number): number => ((i % REEL_LEN) + REEL_LEN) % REEL_LEN;

export interface ReelPlan {
  /** Resting stop before the spin, and the stop it is going to. */
  from: number;
  stopIndex: number;
  /** Time (since spin start) the stop begins, and travel at that moment. */
  stopAt: number;
  y0: number;
  /** Where the ease-out ends (target + overshoot) and where the reel finally rests. */
  yEnd: number; yTarget: number;
  /** Duration of the ease-out and its exponent. */
  decelS: number; k: number;
  /** Travel at which the picture is re-mapped onto the strip that ends at the stop. */
  ySwitch: number;
  teased: boolean;
  /** Time everything is finished. */
  doneAt: number;
}

/** Travel at time t before the stop begins: smoothstep spin-up, then constant speed. */
function runY(t: number): number {
  if (t <= 0) return 0;
  if (t < SPIN_UP_S) { const u = t / SPIN_UP_S; return CRUISE * SPIN_UP_S * (u * u * u - (u * u * u * u) / 2); }
  return CRUISE * SPIN_UP_S * 0.5 + CRUISE * (t - SPIN_UP_S);
}

export function planReel(from: number, stopIndex: number, stopAt: number, teased: boolean): ReelPlan {
  const at = Math.max(stopAt, SPIN_UP_S);
  const y0 = runY(at);
  const k = teased ? 4 : 3;
  const D = teased ? TEASE_RUN : STOP_RUN;
  const yEnd = y0 + D;
  const yTarget = yEnd - OVERSHOOT;
  // initial velocity of D*(1-(1-τ)^k) over T is D*k/T; make it CRUISE so the stop begins with no change in speed
  const decelS = (D * k) / CRUISE;
  // Re-map while at full blur: 2 symbols before the stop begins, but never before the spin-up has finished.
  const ySwitch = Math.max(runY(SPIN_UP_S), y0 - 2);
  return { from: wrap(from), stopIndex: wrap(stopIndex), stopAt: at, y0, yEnd, yTarget, decelS, k, ySwitch, teased, doneAt: at + decelS + SETTLE_S };
}

/** Travel y of a planned reel at time t (seconds since the spin began). Windup is NOT included (see `windup`). */
export function positionAt(p: ReelPlan, t: number): number {
  if (t < p.stopAt) return runY(t);
  const u = (t - p.stopAt) / p.decelS;
  if (u < 1) return p.y0 + (p.yEnd - p.y0) * (1 - Math.pow(1 - u, p.k));
  const s = (t - p.stopAt - p.decelS) / SETTLE_S;
  if (s < 1) return p.yTarget + OVERSHOOT * (1 - smooth(s));
  return p.yTarget;
}

/** The small backward drag at the very start, added to the drawn position only. */
export function windup(t: number): number {
  return t <= 0 || t >= WINDUP_S ? 0 : -WINDUP_DIST * Math.sin((Math.PI * t) / WINDUP_S);
}

/** Strip index (as a float) at the TOP row of the window for travel y. Integer exactly at rest. */
export function topIndex(p: ReelPlan, y: number): number {
  return y < p.ySwitch ? wrap(p.from - y) : wrap(p.stopIndex + (p.yTarget - y));
}

/** Phase of a reel at time t. */
export type ReelPhase = 'windup' | 'spinning' | 'stopping' | 'settling' | 'stopped';
export function phaseAt(p: ReelPlan, t: number): ReelPhase {
  if (t < WINDUP_S) return 'windup';
  if (t < p.stopAt) return 'spinning';
  if (t < p.stopAt + p.decelS) return 'stopping';
  if (t < p.doneAt) return 'settling';
  return 'stopped';
}

/** Instantaneous speed (symbols/s) by central difference; for the motion blur and the clatter. */
export function speedAt(p: ReelPlan, t: number): number {
  const h = 1e-3;
  return Math.max(0, (positionAt(p, t + h) - positionAt(p, Math.max(0, t - h))) / (t > h ? 2 * h : t + h));
}

export interface ReelView {
  /** Strip index of the top symbol, as a float. Integer exactly when at rest. */
  top: number;
  /** floor(top) and its fraction: draw symbol (base + k) at row (k - frac). */
  base: number; frac: number;
}
export function viewOf(p: ReelPlan, y: number): ReelView {
  const top = topIndex(p, y);
  // `top` can sit a hair under an integer after the float maths; snap those so a resting reel is exact
  const snapped = Math.abs(top - Math.round(top)) < 1e-9 ? wrap(Math.round(top)) : top;
  const base = Math.floor(snapped);
  return { top: snapped, base, frac: snapped - base };
}

export interface ReelEvent { reel: number; kind: 'thunk' | 'rest'; t: number }

export interface ReelSet {
  plans: readonly ReelPlan[];
  /** Seconds since the spin began (any dt works; the game's loop clamps it to 0.05). */
  readonly t: number;
  step(dt: number): void;
  /** Slam stop: every reel that has not begun to stop does so now, in order, `gap` apart. */
  slam(gap?: number): void;
  /** Draw travel (position + windup) of a reel now. */
  y(reel: number): number;
  view(reel: number): ReelView;
  phase(reel: number): ReelPhase;
  speed(reel: number): number;
  /** Events (a reel hitting its stop, a reel at rest) since the last call. */
  drain(): ReelEvent[];
  readonly done: boolean;
  /** Total seconds from start to the last reel at rest. */
  readonly duration: number;
}

/**
 * A spin in progress: reels at rest on `from`, going to `stops`, `tease` (a reel index or null)
 * held longer. That reel and every one to its right wait `TEASE_EXTRA_S` more.
 */
export function createReels(from: readonly number[], stops: readonly number[], tease: number | null = null): ReelSet {
  const baseStops = Array.from({ length: REELS }, (_, i) => FIRST_STOP_S + i * STAGGER_S + (tease !== null && i >= tease ? TEASE_EXTRA_S : 0));
  const build = (stopAts: number[]): ReelPlan[] => stops.slice(0, REELS).map((s, i) => planReel(from[i], s, stopAts[i], tease === i));
  let plans = build(baseStops);
  let t = 0;
  const pending: ReelEvent[] = [];
  const thunkAt = (p: ReelPlan): number => p.stopAt + p.decelS;

  const set: ReelSet = {
    get plans() { return plans; },
    get t() { return t; },
    step(dt) {
      const t0 = t;
      t += Math.max(0, dt);
      plans.forEach((p, i) => {
        if (thunkAt(p) > t0 && thunkAt(p) <= t) pending.push({ reel: i, kind: 'thunk', t: thunkAt(p) });
        if (p.doneAt > t0 && p.doneAt <= t) pending.push({ reel: i, kind: 'rest', t: p.doneAt });
      });
    },
    slam(gap = 0.14) {
      const old = plans;
      const at = Math.max(t, SPIN_UP_S);
      let n = 0;
      const stopAts = old.map((p) => (t < p.stopAt ? at + gap * n++ : p.stopAt));
      plans = build(stopAts).map((p, i) => (t < old[i].stopAt ? p : old[i]));
    },
    y: (i) => positionAt(plans[i], t) + windup(t),
    view: (i) => viewOf(plans[i], positionAt(plans[i], t) + windup(t)),
    phase: (i) => phaseAt(plans[i], t),
    speed: (i) => speedAt(plans[i], t),
    drain() { const out = pending.slice(); pending.length = 0; return out; },
    get done() { return t >= Math.max(...plans.map((p) => p.doneAt)); },
    get duration() { return Math.max(...plans.map((p) => p.doneAt)); },
  };
  return set;
}
