/**
 * What `Modifiers.steadyMul` and `Modifiers.sway` actually DO to the player's hands.
 *
 * sim/shop.ts collapses food and drink into those two numbers; this module is the single place
 * that turns them into things a player can feel, so the client consumers (strike timer, camera rigs,
 * dive gate) share one definition and one set of tests. Pure: no three.js, no DOM, time is passed in.
 *
 * ## Why these consumers (and not others)
 *
 * A +5% to a number nobody sees is the same as no buff. Chosen deliberately:
 *  - STRIKE WINDOW (1.4 s). The one place hands matter in the rod loop. Coffee 1.25x -> 1.75 s: a
 *    quarter-second of extra forgiveness, the difference between landing and "Missed it". It is
 *    binary and felt, which is why it carries most of the weight.
 *  - CAMERA/HAND WOBBLE. The first-person rod camera and the dive mask get an idle hand shake;
 *    steadiness divides it (squared, so the first sip is visible). Without a baseline there is
 *    nothing for coffee to remove, so a tiny one (~0.35 deg) exists unbuffed.
 *  - NOT the fight sim: line tension is the rod's job (lineMul), and a buff that quietly changed
 *    break odds would make fight.ts's tuned numbers lie. Rejected.
 *
 * ## Drinking
 *
 * `sway` (0..1) is a LIABILITY, and a funny one: the view rolls and drifts, the strike window
 * shrinks. It is capped so nothing is unplayable: max roll ~7 deg, drift ~2.5 deg, strike window
 * never below `STRIKE_MIN_S`. Controls, air burn and fish behaviour are untouched.
 *
 * DIVING: sway above `DIVE_SWAY_LIMIT` (a shot AND a six-pack together, 0.85) refuses the dive with
 * a joke. A six-pack alone (0.5) may dive: the wobble is camera-only, air and steering are
 * unchanged, so it is survivable, merely silly. Rejected: drunk air burn (a hidden death sentence,
 * not a gag).
 */

/** The unmodified strike window, seconds (game/fishing/update.ts used the literal 1.4). */
export const STRIKE_BASE_S = 1.4;
/** A drunk player still gets a fair chance: never shorter than this. */
export const STRIKE_MIN_S = 0.8;
/** A fully fed player is forgiven at most this much longer than base. */
export const STRIKE_MAX_MUL = 1.5;
/** Sway above which a dive is refused. */
export const DIVE_SWAY_LIMIT = 0.6;

const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

export interface HandInputs { steadyMul: number; sway: number }

/** Seconds the player has to strike once the float goes under. */
export function strikeWindowS(base: number, m: HandInputs): number {
  // steadyMul already carries the drink penalty (shop.ts: x(1 - 0.4 sway)); sway then narrows it
  // once more so a drunk strike is late by feel, not just by arithmetic.
  const s = base * clamp(m.steadyMul, 0.5, STRIKE_MAX_MUL) * (1 - 0.25 * clamp(m.sway, 0, 1));
  return Math.max(Math.min(base, STRIKE_MIN_S), s);
}

/** True when the player is too far gone to be allowed over the side. */
export const tooDrunkToDive = (m: HandInputs): boolean => m.sway > DIVE_SWAY_LIMIT;

export interface HandWobble {
  /** Radians to add to camera pitch / yaw / roll. */
  pitch: number; yaw: number; roll: number;
  /** Multiplier for an existing idle sway (the mask camera already has one). 1 = unchanged. */
  ampMul: number;
}

const BASE_AMP = 0.006;

/** Deterministic in `t` (simulated seconds) so it is testable and replays identically. */
export function handWobble(t: number, m: HandInputs): HandWobble {
  const steady = clamp(m.steadyMul, 0.5, 2);
  const s = clamp(m.sway, 0, 1);
  const ampMul = 1 / (steady * steady);
  const idle = BASE_AMP * ampMul;
  return {
    pitch: Math.sin(t * 1.7) * idle + Math.sin(t * 0.9 + 1) * 0.03 * s,
    yaw: Math.sin(t * 1.3 + 2) * idle + Math.sin(t * 0.5 + 2) * 0.045 * s,
    roll: Math.sin(t * 0.8) * 0.12 * s,
    ampMul,
  };
}

/* ------------------------------------------------------------------------------------------ *
 * Buff bookkeeping for the toast and the HUD, derived purely from Inventory.buffs.
 * ------------------------------------------------------------------------------------------ */

/** Display names for the buff strip and toasts. */
export const BUFF_LABELS: Readonly<Record<string, string>> = {
  'diner.coffee': 'Coffee',
  'diner.mahi': 'Mahi sandwich',
  'diner.pie': 'Key lime pie',
  'bar.wings': 'Hot wings',
  'icecream.cone': 'Ice cream',
  'conv.snacks': 'Snacks',
  'bar.shot': 'Key lime shot',
  'liquor.sixer': 'Six-pack',
};

export const isDrink = (key: string): boolean => key === 'bar.shot' || key === 'liquor.sixer';

/** Which timed buffs are live at `nowS`, soonest-to-expire first, with whole seconds remaining. */
export function liveBuffs(buffs: Readonly<Record<string, number>>, nowS: number): Array<{ key: string; left: number }> {
  return Object.entries(buffs)
    .filter(([, exp]) => exp > nowS)
    .map(([key, exp]) => ({ key, left: Math.ceil(exp - nowS) }))
    .sort((a, b) => a.left - b.left);
}

/** Keys that appeared / disappeared between two sets of live keys, driving the on/off toasts. */
export function buffEdges(prev: ReadonlySet<string>, now: ReadonlySet<string>): { started: string[]; ended: string[] } {
  return {
    started: [...now].filter((k) => !prev.has(k)),
    ended: [...prev].filter((k) => !now.has(k)),
  };
}

/** The toast for a buff taking effect. Short, honest about the effect, never grim. */
export function startToast(key: string): string {
  const name = BUFF_LABELS[key] ?? key;
  if (key === 'bar.shot') return name + ': the horizon is optional now. Hands less steady.';
  if (key === 'liquor.sixer') return name + ': the deck party approves, your rod does not.';
  return name + ': steadier hands, longer strike window.';
}

export function endToast(key: string): string {
  const name = BUFF_LABELS[key] ?? key;
  return isDrink(key) ? name + ' wears off. The dock stops moving.' : name + ' wears off.';
}
