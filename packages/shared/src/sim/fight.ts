/**
 * Rod-and-reel fight resolution, plus the species/weight roll that feeds it.
 *
 * Ported from legacy/index.html's `updateFishing`'s `F.state==='fight'` branch (2778-2810),
 * `setHook` (2664-2678, the fight's initial conditions) and `chooseFish`/`pickSpecies`
 * (2650-2660, the species and weight roll). Faithful to every constant and evaluation order;
 * the only real change is structural, per docs/ARCHITECTURE.md ("Rod fishing,
 * server-authoritative") and the task brief:
 *
 * ⚠ Today `chooseFish()` rolls species *and* weight client-side with `Math.random()` and writes
 * straight to the leaderboard — the exact vulnerability docs/ARCHITECTURE.md is built around
 * ("The leaderboard is reachable only through server-generated catch rows"). `pickSpecies`,
 * `rollWeight` and `stepFight` below take an injected `Rng` instead of calling `Math.random()`
 * directly, and are pure (no DOM, no three.js, no `Date.now()`) — exactly the shape phase 3
 * needs to move this code onto the server unchanged. **This module does not call the server and
 * does not write a leaderboard row** — apps/client/src/game/fishing calls it today with a
 * client-local `Rng` purely for immediate feedback (the existing single-player behaviour); the
 * net agent wires an authoritative server roll on top of the exact same function later. Do not
 * read "the client calls `chooseFish`" as "the client is trusted" — it isn't, yet; nothing here
 * decides that.
 *
 * Presentation (hooked-fish mesh, line, bobber, jump animation, splash particles, camera shake,
 * toasts) stays client-side, same split as `sim/boat.ts`'s `events` convention: this module
 * reports discrete happenings via `FightState.events` instead of causing them.
 */

import { SPECIES, SOUNDERS, BILLFISH, ZONE_TABLE } from '../content/species.js';
import { VIS, isCatchable } from '../content/creatures.js';
import { offshoreF, depthAt, landH, type Zone, type Hump } from '../world/depth.js';
import { weightedPick, type Rng } from '../rng/index.js';
import { clamp, lerp } from '../internal/math.js';
import { STARTER_TACKLE, tackleById, type Tackle } from '../content/tackle.js';

// re-exported so callers don't need a second import just for the zone key union
export type { Zone };

/** Spool radius with a full load of line, metres — a 50-size conventional reel's arbor plus
 * ~300 m of 30 lb mono. */
export const SPOOL_FULL_R = 0.045;
/** Bare-arbor radius, metres: the floor `spoolRadiusFor` approaches as line runs out. */
export const SPOOL_ARBOR_R = 0.019;
/** Line length (m) at which the spool is treated as down to the arbor. Past this the radius stays
 * at `SPOOL_ARBOR_R` rather than going imaginary. */
export const SPOOL_EMPTY_AT = 260;

/**
 * Effective spool radius for `lineOut` metres of line already paid out.
 *
 * Line lies on the spool in layers, so the radius falls as the square root of the remaining line,
 * not linearly — that is why the pitch of a screaming drag climbs slowly at first and then runs
 * away near the end of a long run.
 */
export function spoolRadiusFor(lineOut: number): number {
  const remaining = clamp(1 - lineOut / SPOOL_EMPTY_AT, 0, 1);
  const r2 = SPOOL_ARBOR_R * SPOOL_ARBOR_R + remaining * (SPOOL_FULL_R * SPOOL_FULL_R - SPOOL_ARBOR_R * SPOOL_ARBOR_R);
  return Math.sqrt(r2);
}

/** legacy `rand(a,b)` (index.html:323) — uniform draw from the injected stream, not `Math.random()`. */
function rand(rng: Rng, a: number, b: number): number {
  return a + (b - a) * rng();
}

/* ------------------------------------------------------------------------------------------ *
 * The species + weight roll (legacy `pickSpecies`/`chooseFish`, index.html:2650-2660)
 * ------------------------------------------------------------------------------------------ */

export interface ChooseFishOpts {
  /** Is the cast landing inside a hotspot (bird/bait school, weedline, rig)? legacy `F.hs`. */
  hotspot: boolean;
  /** legacy `nearHump(F.bob.x,F.bob.z)` — boosts amberjack/blackfin/kingfish near an offshore hump. */
  hump: Hump | null;
  /** Rigged-bait odds multiplier for the rarer end of the zone table (`Modifiers.rareMul`, here
   * only while a ballyhoo is on the hook). 1/undefined = the table as it always was. */
  rareMul?: number;
}

/** A table entry counts as the "rarer end" when its raw odds are at most this. Absolute rather
 * than relative to the table's max on purpose: Offshore's top entry is 6 (mahi) and its rare end
 * (sailfish 2, marlin 1.3, swordfish 1.1, bluefin .4) sits below 2, and Creek's whole table is
 * 2..5, so a relative cut would have made snook "rare" in a creek. Measured on Offshore: 2 puts
 * wahoo, sailfish and the marlins on the boosted side and leaves mahi/blackfin/skipjack alone. */
export const RARE_ODDS_MAX = 2;

/**
 * legacy `pickSpecies(zone,hs)` (index.html:2650-2653). `zone` takes `Zone | (string & {})` —
 * loosened past `world/depth.ts`'s `Zone` union deliberately: `ZONE_TABLE` (content/species.ts)
 * also has `'Weedline'`/`'Oil Rig'` entries that `zoneAt()` never returns (those come from
 * WEEDS/RIGS/hotspots — stubbed empty in src/stubs.ts, owned by the fish/world agents). This
 * function doesn't need to know that; it just looks the string up in `ZONE_TABLE`, so whichever
 * agent wires hotspot detection back up can pass `'Weedline'`/`'Oil Rig'` straight through.
 */
export function pickSpecies(zone: Zone | (string & {}), bob: { x: number; z: number }, opts: ChooseFishOpts, rng: Rng): string {
  const tbl = ZONE_TABLE[zone] ?? [];
  const f = zone === 'Offshore' ? offshoreF(bob.x, bob.z) : 0;
  const BIG: Record<string, number> = { marlin: 1, swordfish: 1, bluefin: 1, yellowfin: 0.6, wahoo: 0.5, sailfish: 0.3 };
  // `isCatchable` filters defensively (docs/ARCHITECTURE.md "Fish ownership — three tiers": a
  // species with `catchable: false` — marine mammals today — "has no server representation at
  // all"): ZONE_TABLE should never contain one in the first place, but this is the one place the
  // roll actually happens, so it's also the one place that must refuse to produce one even if a
  // future edit mistakenly adds one to a zone table. See test/catchable.test.ts.
  const weighted: Array<[string, number]> = tbl.filter(([k]) => isCatchable(k)).map(([k, v]) => {
    let x = opts.hotspot && v < 2.5 ? v * 2.5 : v;
    x *= BIG[k] ? 1 + 4 * f * BIG[k] : 1 - 0.45 * f;
    // Ballyhoo skews the roll, it never replaces it: the rarer end is multiplied, everything else
    // is untouched, so a 2x bait roughly doubles the share of wahoo/sailfish/marlin without
    // making an offshore cast a guaranteed billfish (tested in gear.test.ts).
    if (opts.rareMul && v <= RARE_ODDS_MAX) x *= opts.rareMul;
    if (opts.hump && (k === 'amberjack' || k === 'blackfin' || k === 'kingfish')) x *= 4;
    return [k, x];
  });
  return weightedPick(rng, weighted);
}

/** Odds that a hooked fish is a fish of a lifetime, before the offshore/hotspot boosts. */
export const TROPHY_TAIL_P = 0.05;

/**
 * Where a fish sits in its species' weight range (0..1) when it lives on a wreck - the ONE
 * function both the rod (`rollWeight`) and the underwater schools (`FishMember.sizeU`, built in
 * entities/fish/spawn.ts) use, so the fish you can see holding on a wreck are drawn from exactly
 * the distribution a cast there promises. Three uniforms in: the body, and a trophy roll.
 *
 * Why not just shift the reef roll up (`hotspot` x1.2): that left a wreck cast looking like a
 * slightly better reef cast. A wreck is where fish *stay* for years and get old, so the floor is
 * raised (nothing under a quarter of the range lives there) and the shape is flat instead of
 * piled at the bottom (`u^0.9` against the reef's `u^1.8`), with a heavier lifetime-fish tail.
 * Numbers measured against Reef and Oil Rig in apps/client/test/playthrough-weights.mjs.
 */
export const WRECK_SIZE_FLOOR = 0.25;
export const WRECK_TROPHY_P = 0.2;
export function wreckSizeT(body: number, trophy: number, tail: number): number {
  let t = WRECK_SIZE_FLOOR + (1 - WRECK_SIZE_FLOOR) * Math.pow(body, 0.9);
  if (trophy < WRECK_TROPHY_P) t = Math.max(t, 0.8 + 0.2 * Math.pow(tail, 0.7));
  return Math.min(1, t);
}

/**
 * legacy `chooseFish`'s weight roll (index.html:2657), plus a trophy tail.
 *
 * Why the tail: the legacy shape `rng^1.8` piles mass at the bottom of every species' range and
 * only reaches the top 15% about 9% of the time inshore, so a 400 lb shark or an 80 lb grouper was
 * a once-in-a-session rarity, and the weight ceiling (p99 inshore ~50-80 lb, max ~480) rarely
 * mattered. Measured per zone by apps/client/test/playthrough-weights.mjs. The tail re-rolls a
 * fraction of fish into the top 20% of their range (offshore and hotspots more), so the ceiling
 * is actually used. Rejected: shifting the whole distribution up, which makes every fish bigger
 * and none of them special, and which on the old sim just inflated scores because every hooked
 * fish was landed. The fight model is what makes these earned: see `FightParams.pullN`.
 */
export function rollWeight(key: string, bob: { x: number; z: number }, hotspot: boolean, rng: Rng, wreck = false): number {
  const S = SPECIES[key];
  if (wreck) return +(S.min + (S.max - S.min) * wreckSizeT(rng(), rng(), rng())).toFixed(1);
  const of = offshoreF(bob.x, bob.z);
  let t = Math.min(1, Math.pow(rng(), 1.8 - 1.2 * of) * (hotspot ? 1.2 : 1) * (1 + 0.3 * of));
  if (rng() < TROPHY_TAIL_P * (hotspot ? 1.8 : 1) * (1 + of)) t = Math.max(t, 0.8 + 0.2 * Math.pow(rng(), 0.7));
  const w = S.min + (S.max - S.min) * t;
  return +w.toFixed(1);
}

export interface HookedFish {
  key: string;
  weight: number;
  /** Where the fish actually sits, offset from the bobber (legacy `F.fx`/`F.fz`). */
  x: number;
  z: number;
  /** Station-keeping offset from the bobber while waiting (legacy `F.ofx`/`F.ofz`). */
  ofx: number;
  ofz: number;
}

/** legacy `chooseFish()` (index.html:2655-2660), fully: species, weight, and spawn position. */
export function chooseFish(zone: Zone | (string & {}), bob: { x: number; z: number }, opts: ChooseFishOpts, rng: Rng): HookedFish {
  const key = pickSpecies(zone, bob, opts, rng);
  const weight = rollWeight(key, bob, opts.hotspot, rng, zone === 'Wreck');
  const a = rng() * Math.PI * 2;
  return { key, weight, x: bob.x + Math.cos(a) * 11, z: bob.z + Math.sin(a) * 11, ofx: Math.cos(a) * 1.3, ofz: Math.sin(a) * 1.3 };
}

/* ------------------------------------------------------------------------------------------ *
 * The fight itself (legacy `setHook` + `updateFishing`'s fight branch, rebuilt — see below)
 * ------------------------------------------------------------------------------------------ */

/*
 * WHY THIS WAS REBUILT. The legacy fight was not a contest. An offline Monte Carlo over this
 * very module (apps/client/test/playthrough-model.mjs, fixed seed, thousands of fights) measured:
 * a trivial bang-bang bot won 100%, a 600 ms-reaction human 96%, and a 900 lb bluefin was landed
 * as reliably as a 2 lb trout. Worse, drag was not a trade-off: 99.9-100% at every setting 1..5
 * while mean fight length fell from 11.4 s to 6.7 s, so drag 5 was strictly best for every
 * species (the per-species "best drag" sweep picked drag 1 for 49/49 purely by tie-breaking, the
 * signature of a knob that does nothing). Root causes, all fixed here:
 *   - tension was a free integrator the player merely had to keep < 1.06; nothing else could kill
 *     a fight, and the fish started 11 m away so there was no time for anything to accumulate;
 *   - line strength, spool and fish force were unrelated constants, so tackle could not matter;
 *   - drag only scaled two multipliers by +-15%, never the physics of who wins.
 *
 * THE MODEL. Tension is normalised so 1.0 = the rated breaking strength of the weaker of
 * line/leader (`Tackle`). The drag is a clutch that slips at `DRAG_FRAC[drag] * lineLb`:
 *   - fish force below the clutch: the line just holds, the fish cannot take line, load = its pull;
 *   - above it: the clutch slips, load is *capped at the setting*, and the fish takes line in
 *     proportion to how far it exceeds it. A loose drag therefore gives line (long runs, a longer
 *     fight, spooling, more time for chafe and hook wear); a tight one stops the fish (short
 *     fight) but every transient the clutch cannot absorb - run-start bolt, head shake, a jump
 *     landing on a tight line - rides on top of a high baseline and is amplified by `stiff`.
 * Failure modes (each one an angler would name it): break-off from overload or shock
 * (`snapped`), leader chafe weakening the line over a long fight (`frayed`), the hook tearing
 * out under load or shaking out on slack during a jump (`pulled`), `slack`, `spooled`, `mangrove`.
 * "Horsing" is real: reeling against a *green* running fish adds `HORSE` on top of the drag
 * load; against a tired one it adds little. Pump while it rests, feather while it runs.
 */

/** Clutch slip force as a fraction of line rating at drag 1..5 (interpolated for 2.5 etc).
 * Real anglers set ~1/4-1/3; 5 is a deliberately dangerous 'lock it down'. */
export const DRAG_FRAC: readonly number[] = [0.14, 0.22, 0.30, 0.39, 0.49];
/** Added load, in line ratings, from cranking against a fresh running fish. */
const HORSE = 0.36;
/** Fish burst force, lb, at str 1 and 1 lb: `FORCE_K * str^1.3 * sqrt(weight)`. Measured so a
 * 100 lb yellowfin pulls ~0.9x a 30 lb line and a 900 lb bluefin ~3x it. */
const FORCE_K = 1.7;

/** Local species groups for failure rates. Kept here, not in content/species.ts, because they are
 * fight-tuning and not catalogue facts; keys are checked by fight.test.ts. */
/**
 * Peak height of a jump, metres, before the fish's own size is taken into account.
 *
 * This used to be a flat 1.4 m in the renderer for everything that could jump, which put a
 * seventy-pound tarpon and a schoolie mahi at exactly the same altitude. A tarpon's whole
 * reputation is the jump — it is the reason people fish for something they will never eat, and a
 * big one throws its entire body clear and lands on its side hard enough to hear. The billfish
 * greyhound rather than leap, which is long and low, and a kingfish mostly just skyrockets once.
 */
const JUMP_HEIGHT_M: Readonly<Record<string, number>> = {
  tarpon: 3.1,
  mako: 2.4,          // the one shark that genuinely clears the water
  blacktip: 1.9,
  ladyfish: 1.6,      // "poor man's tarpon", and it earns the name
  sailfish: 1.5, marlin: 1.5, blackmarlin: 1.5, swordfish: 1.4,  // greyhounding: long, not high
  mahi: 1.5, snook: 1.0, kingfish: 1.1, jackcrevalle: 0.9, barracuda: 1.3,
};
const JUMP_HEIGHT_DEFAULT = 1.2;

const TOOTHY = new Set(['wahoo', 'barracuda', 'kingfish', 'cero', 'spanishmack', 'bluerunner', 'blacktip', 'bullshark', 'lemonshark', 'hammerhead']);
const SOFT_MOUTH = new Set(['trout', 'tarpon', 'ladyfish', 'mahi', 'sheepshead', 'lookdown']);

/** Fraction of line rating the clutch slips at, for a (possibly fractional) drag setting. */
export function dragFraction(drag: number): number {
  const p = clamp(drag, 1, 5) - 1;
  const i = Math.min(3, Math.floor(p));
  return lerp(DRAG_FRAC[i], DRAG_FRAC[i + 1], p - i);
}

/** Derived, constant for the whole fight (legacy `F.str`/`F.maxLine` + the species flags its
 * jump/sound logic reads). Computed once by `startFight`, passed back into every `stepFight`. */
export interface FightParams {
  key: string;
  weight: number;
  /** legacy `F.str = S.str*(.8+.55*sizeT)` — size-scaled fight strength. */
  str: number;
  /** legacy `F.maxLine = S.str>1.2?320:200`, times the tackle's spool factor. */
  maxLine: number;
  /** legacy `S.jump`. */
  jump: boolean;
  /** legacy's one-off `F.key==='kingfish'` jump case — kingfish isn't `S.jump` but gets its own
   * (lower-odds, single-jump) roll in `setHook`. */
  kingfish: boolean;
  billfish: boolean;
  sounder: boolean;
  /** Scaled fish length in meters (legacy `VIS[key].len*s`, `s` from `showHooked`/`setupPhoto`'s
   * `clamp(Math.cbrt(weight/avgWeight),.75,1.5)`), used only to flavor jump duration/height. */
  lenM: number;
  /** Drag setting at the start of the fight; `FightInput.drag` overrides it live. */
  drag: number;
  tackle: Tackle;
  /** Rated breaking strength the tension is normalised to: min(line, leader), lb. */
  ratingLb: number;
  /** Fish burst force, lb (see `FORCE_K`). */
  forceLb: number;
  /** `forceLb / ratingLb`: how many line-ratings of pull a fully fresh run exerts. The single
   * number that says whether this fish is a formality or a gamble on this tackle. */
  pullN: number;
  /** Stamina scale: bigger fish last longer under the same pressure. */
  endure: number;
  /** Peak jump height for THIS fish, metres — species tendency scaled by how big it is. Purely
   * presentational: `sim` never reads it, the renderer draws the arc with it. */
  jumpHeightM: number;
  /** Relative hook-throw tendency: jumpers and soft-mouthed fish are worse. */
  hookRisk: number;
  /** Relative leader-chafe rate: teeth, rocks, wrecks. */
  rough: number;
}

/** legacy `showHooked`/`setupPhoto`'s `clamp(Math.cbrt(weight/avgWeight),.75,1.5)` size scale,
 * applied to `VIS[key].len` — how big to draw/size a given catch relative to its species'
 * average. Exported so presentation code (the hooked-fish mesh, the catch portrait) can size a
 * mesh identically to how `fightParamsFor` derives `lenM`, without duplicating the formula. */
export function scaledLenM(key: string, weight: number): number {
  const S = SPECIES[key];
  const scale = clamp(Math.cbrt(weight / ((S.min + S.max) / 2)), 0.75, 1.5);
  return VIS[key].len * scale;
}

/**
 * The gauge reading: how close this load is to parting the line RIGHT NOW, 0..1 and beyond.
 *
 * The bar used to show raw `tension` on a fixed 0..1 scale, and that is what made it useless.
 * Two separate things were wrong with it.
 *
 * First, the scale did not match the failure point. The line parts at `limit`, which starts at 1
 * and falls to 0.45 as the leader chafes, so late in a long fight it let go at 45% of a bar that
 * was still painted green to 82%. That much was fixed by sliding the painted zones leftwards as
 * the leader wore — but a gauge whose MARKINGS move while the needle's scale stays put is a
 * strange object to read, and it still left the second problem untouched.
 *
 * Second, and worse: on an ordinary fish the needle never went anywhere. Measured over full
 * fights, a blackfin or a grouper runs between 0.2 and 0.5 tension and peaks at 0.72 at the
 * tightest drag the reel has — against a red zone that begins around 0.76. The HUD says "back
 * off when the bar runs red" and for the overwhelming majority of fish in this game it was
 * physically impossible for the bar to run red at any drag setting. The instruction was a lie
 * and the bottom half of the bar was the only half in use.
 *
 * Dividing by the live limit fixes both at once. Full bar always means "the line is going now",
 * the red is always in the same place, and the same 0.72 on a blackfin reads as 76% of what the
 * line will take — which is the truth, and is finally worth watching. A worn leader then pushes
 * the needle right on its own, because the same pull really has got closer to breaking it.
 */
export function tensionFrac(tension: number, limit: number): number {
  return tension / Math.max(0.05, limit);
}

/**
 * The tension above which the hook starts tearing its way out, quadratically — `stepFight`'s
 * hook-wear term is built on this exact number. It is the real back-off point, and it is what
 * the gauge's warning mark means.
 *
 * The mark used to be a fixed fraction of the LINE limit — 0.8, then 0.68 — which is a different
 * quantity and the wrong one. Line parting is not how most fish are lost; the hook pulling is.
 * Measured over full fights at every drag setting, cranking flat out: a 22 lb red grouper peaks
 * at 0.46-0.59 tension and spends 12-24% of the fight above this threshold, and a 30 lb blackfin
 * 0.50-0.72 and 19-37% of it. Against a 0.68-of-limit mark, neither ever turned the bar red. The
 * gauge sat green through the whole band in which the player was prising the hook loose, which
 * is precisely the thing it exists to warn about.
 *
 * The drag knob stays legible, which was the reason the old number was chosen: time spent past
 * this mark still rises with drag on every fish (blackfin 19% at drag 1 to 37% at drag 5). And a
 * fish that genuinely cannot endanger itself still never lights it — a 4 lb lane snapper peaks
 * at 0.29 at every drag setting, and should read safe, because it is.
 */
export const HOOK_TEAR = 0.4;

/**
 * Below this, a jump or a head shake throws the hook — `stepFight`'s slack-wear term uses it.
 * The gauge's slack warning reads the same number, so what it shows and what kills you agree.
 */
export const SLACK_TENSION = 0.12;

/**
 * Where the warning mark belongs on the bar, 0..1 of the track, for a leader in this condition.
 *
 * It MOVES, unlike the old fixed 68%. The bar shows tension over `limit`, and the hook tears at
 * a fixed tension, so as the leader chafes and `limit` falls the mark slides right and the band
 * between "tearing the hook" and "parting the line" narrows — which is exactly what is happening
 * to the angler.
 */
export function warnFrac(limit: number): number {
  return Math.min(1, tensionFrac(HOOK_TEAR, limit));
}

/**
 * What owned gear and a spent consumable change in a fight. A structural subset of shop.ts's
 * `Modifiers` (so a whole bag can be passed straight in) plus the one consumable effect that
 * belongs to the fight and not to the cast: a fluorocarbon leader.
 */
export interface FightGear {
  /** Multiplies main-line AND leader rating (heavy rod, lever reel's stiffer blank). */
  lineMul?: number;
  /** Multiplies unloaded retrieve speed (lever-drag two-speed). */
  reelMul?: number;
  /** A fluorocarbon leader is on this rig (spent at the cast; see sim/gear.ts). */
  fluoro?: boolean;
}

/** Fraction of leader chafe rate that remains with a fluoro leader, by fish kind. Toothy fish are
 * the shelf's stated purpose ("fewer bite-offs on toothy fish"), so they get the big cut;
 * everyone else a small one (fluoro also resists rock and mangrove). It only slows the chafe
 * clock; it never touches snap/pull/slack/spool, so it cannot make a fight safe. */
export const FLUORO_ROUGH_MUL_TOOTHY = 0.5;
export const FLUORO_ROUGH_MUL_OTHER = 0.85;

/**
 * Applies gear to a tackle outfit. Done on the Tackle itself, BEFORE anything is derived, so
 * `ratingLb`, `Dn = dragFraction * lineLb / ratingLb`, `pullN` and the fray clock all see one
 * consistent outfit. Scaling only the rating would have skewed Dn, i.e. made the drag setting
 * mean something different on a heavy rod; scaling line and leader together keeps `Dn` (the
 * clutch as a fraction of rating) identical, so the drag trade-off is untouched and gear only
 * moves how many line-ratings the fish pulls (`pullN`). That is what stops a heavy rod from
 * becoming a drag-5 cheat code.
 */
export function applyGear(tackle: Tackle, gear?: FightGear): Tackle {
  const lm = gear?.lineMul ?? 1, rm = gear?.reelMul ?? 1;
  if (lm === 1 && rm === 1) return tackle;
  return { ...tackle, lineLb: tackle.lineLb * lm, leaderLb: tackle.leaderLb * lm, reelMs: tackle.reelMs * rm };
}

export function fightParamsFor(key: string, weight: number, drag: number, baseTackle: Tackle = tackleById(STARTER_TACKLE), gear?: FightGear): FightParams {
  const tackle = applyGear(baseTackle, gear);
  const S = SPECIES[key];
  const sizeT = (weight - S.min) / (S.max - S.min);
  const str = S.str * (0.8 + 0.55 * sizeT);
  const ratingLb = Math.min(tackle.lineLb, tackle.leaderLb);
  const sounder = SOUNDERS.has(key);
  const forceLb = FORCE_K * Math.pow(str, 1.3) * Math.sqrt(weight);
  return {
    key, weight, str,
    maxLine: (S.str > 1.2 ? 320 : 200) * tackle.spool,
    jump: !!S.jump,
    kingfish: key === 'kingfish',
    billfish: BILLFISH.has(key),
    sounder,
    lenM: scaledLenM(key, weight),
    // A big fish of a species jumps higher than a small one, but not in proportion — it is
    // throwing a much heavier body, so the gain is gentle and capped.
    jumpHeightM: (JUMP_HEIGHT_M[key] ?? JUMP_HEIGHT_DEFAULT) * clamp(0.78 + 0.5 * sizeT, 0.78, 1.28),
    drag,
    tackle, ratingLb, forceLb, pullN: forceLb / ratingLb,
    endure: 0.8 + 0.5 * Math.log10(1 + weight),
    hookRisk: 1 + (S.jump ? 0.3 : 0) + (SOFT_MOUTH.has(key) ? 0.4 : 0),
    rough: (TOOTHY.has(key) ? 2.4 : sounder ? 1.6 : 1)
      * (gear?.fluoro ? (TOOTHY.has(key) ? FLUORO_ROUGH_MUL_TOOTHY : FLUORO_ROUGH_MUL_OTHER) : 1),
  };
}

export type FightOutcome = 'fighting' | 'landed' | 'snapped' | 'frayed' | 'pulled' | 'slack' | 'spooled' | 'mangrove';

export type FightEvent =
  | { type: 'splash'; x: number; z: number; big: boolean }
  | { type: 'startRun' }
  | { type: 'startJump'; low: boolean }
  | { type: 'sounding' }
  /** A transient the clutch could not absorb (bolt, head shake, jump landing on a tight line).
   * `mag` is the added tension. Presentation-only: the rod kicks and the line twangs. */
  | { type: 'shock'; mag: number };

export interface FightState {
  x: number;
  z: number;
  /** Line load as a fraction of the rated breaking strength; may exceed 1 transiently. */
  tension: number;
  stam: number;
  running: boolean;
  runT: number;
  runAng: number;
  pull: number;
  slackT: number;
  overT: number;
  /** legacy `F.shake` — hook-mesh wiggle intensity, cosmetic but kept for presentation parity. */
  shake: number;
  shakeT: number;
  jumpQ: number;
  /** True while the fish is "airborne" for tension-modeling purposes (legacy `jumpFish`
   * existing). Deterministic here — timed out by `airT` — rather than driven by a client-only
   * three.js animation object, so server and client agree on when the tension/stamina "air"
   * bonus applies. */
  airborne: boolean;
  airT: number;
  deep: number;
  deepT: number;
  dist: number;
  /**
   * Rate of change of `dist`, m/s, signed: **positive = line paying off the spool**, negative =
   * line coming back on. This is not a cosmetic number — it is literally `d(dist)/dt`, and line
   * length *is* the fish-to-boat distance, so it is the physically correct line speed with no
   * extra model needed.
   *
   * Exists because a reel's drag clicker ticks at a rate proportional to spool RPM, and RPM is
   * line speed over spool radius. Before this the clicker had three hardcoded rates switched by
   * a mode enum, which is why it read as a synth buzz rather than a drag: a fish screaming off at
   * 8 m/s and one easing away at 0.5 m/s made the identical sound.
   */
  lineSpeed: number;
  /**
   * Effective spool radius, metres, shrinking as line pays out — see `SPOOL_FULL_R`.
   * `rpm = lineSpeed / (2*PI*spoolR)`, which is what gives a long run its rising scream: the
   * further the fish goes the smaller the spool gets and the faster it has to spin for the same
   * line speed. Purely a function of `dist`, so it needs no state of its own.
   */
  spoolR: number;
  /** Seconds since the hook set. A long fight is a risky fight: hook wear scales with this. */
  t: number;
  /** Leader chafe, 0..1. Lowers `limit` (and so what a given load can do) for the rest of the fight. */
  abrasion: number;
  /** Hook security, 1 = buried, 0 = out. Starts random (how well it set), then only wears down. */
  hookHold: number;
  /** Load (fraction of rating) at which the line parts right now: 1 less chafe. For the HUD. */
  limit: number;
  /** True while the clutch is slipping, i.e. the fish is taking line against the drag. */
  slipping: boolean;
  outcome: FightOutcome;
  events: FightEvent[];
}

/** legacy `setHook` (index.html:2664-2678), minus the DOM/audio/camera-shake side effects
 * (reported as `events` instead — see `FightState.events`). */
export function startFight(params: FightParams, fishX: number, fishZ: number, rng: Rng): FightState {
  const state: FightState = {
    x: fishX, z: fishZ,
    tension: 0.3, stam: 1,
    running: true, runT: rand(rng, 2, 4), runAng: rand(rng, -0.7, 0.7), pull: params.str * 1.05,
    slackT: 0, overT: 0,
    shake: 0.5, shakeT: rand(rng, 0.6, 1.4),
    jumpQ: 0, airborne: false, airT: 0,
    deep: 0, deepT: 0,
    dist: 0, lineSpeed: 0, spoolR: SPOOL_FULL_R,
    t: 0, abrasion: 0, hookHold: rand(rng, 0.55, 1), limit: 1, slipping: false,
    outcome: 'fighting',
    events: [{ type: 'splash', x: fishX, z: fishZ, big: true }],
  };
  if (params.jump && rng() < 0.85) state.jumpQ = params.billfish ? 2 + Math.floor(rng() * 3) : 1;
  else if (params.kingfish && rng() < 0.6) state.jumpQ = 1;
  else if (params.sounder) state.deepT = rand(rng, 3, 7);
  return state;
}

export interface FightInput {
  reeling: boolean;
  /** Live drag setting 1..5. Omitted = `params.drag`. The client passes its current knob every
   * tick; before this, turning the drag mid-fight changed the clicker's sound and nothing else. */
  drag?: number;
}

export interface FightEnv {
  boatX: number;
  boatZ: number;
}

/** legacy `updateFishing`'s `F.state==='fight'` branch (index.html:2778-2810). Pure: returns a
 * new `FightState`, never mutates `state`/`input`/`env`/`params`. `dt` should be the fixed-step
 * timestep per docs/ARCHITECTURE.md's netcode table (30 Hz server-side); the function itself is
 * timestep-agnostic. `rng` must be the same stream across calls for a given fight (seeded once
 * at `startFight`) for determinism — see fight.test.ts. */
export function stepFight(state: FightState, input: FightInput, params: FightParams, env: FightEnv, rng: Rng, dt: number): FightState {
  if (state.outcome !== 'fighting') return state;
  const next: FightState = { ...state, events: [] };
  const { str, jump: jumper, billfish: bill, sounder, pullN } = params;
  const reel = input.reeling;
  const Dn = dragFraction(input.drag ?? params.drag) * params.tackle.lineLb / params.ratingLb;
  // Shock stiffness: a locked-down clutch cannot give, so the same bolt or shake lands harder.
  const stiff = 0.3 + 4.0 * Math.pow(Dn, 1.2);
  const shock = (mag: number): void => { next.tension += mag; next.events.push({ type: 'shock', mag }); };
  next.t += dt;

  next.runT -= dt;
  if (next.running && next.runT <= 0) {
    next.running = false;
    next.runT = rand(rng, 1.4, 3.2) * (1.3 - next.stam * 0.4);
  } else if (!next.running && next.runT <= 0) {
    next.running = true;
    next.runT = rand(rng, 0.9, 2.4) * (0.5 + next.stam * 0.8);
    next.runAng = rand(rng, -1.1, 1.1);
    next.pull = str * rand(rng, 0.7, 1.1) * (0.45 + 0.55 * next.stam);
    next.events.push({ type: 'splash', x: next.x, z: next.z, big: false }, { type: 'startRun' });
    // The bolt: a fresh fish leaving hits a tight line hard, a slack-ish one barely.
    shock(0.2 * Math.min(1.6, pullN * (next.pull / str)) * stiff * (reel ? 1.2 : 0.35));
    if (jumper && rng() < 0.4 + 0.4 * next.stam) {
      next.jumpQ = bill ? 2 + Math.floor(rng() * 3) : 1 + (rng() < 0.3 ? 1 : 0);
    } else if (sounder && rng() < 0.6) {
      next.deepT = rand(rng, 4, 9);
      next.events.push({ type: 'sounding' });
    }
  }
  if (next.jumpQ > 0 && !next.airborne) {
    const low = bill && next.jumpQ > 1;
    next.airborne = true;
    next.airT = low ? 0.55 + params.lenM * 0.08 : 1.1 + params.lenM * 0.18;
    next.jumpQ -= 1;
    next.deepT = 0;
    next.events.push({ type: 'startJump', low }, { type: 'splash', x: next.x, z: next.z, big: !low });
  }
  if (next.airborne) {
    next.airT -= dt;
    if (next.airT <= 0) {
      next.airborne = false;
      next.events.push({ type: 'splash', x: next.x, z: next.z, big: true });
      // Re-entry on a tight line is the classic jump break-off; on a bowed one it is nothing.
      shock(0.3 * Math.min(1.2, pullN + 0.3) * stiff * clamp((next.tension - 0.15) / 0.4, 0, 1));
    }
  }

  next.shakeT -= dt;
  if (next.shakeT <= 0) {
    next.shakeT = rand(rng, 0.5, 1.8) * (1.4 - next.stam * 0.6);
    next.shake = 0.35;
    shock(0.16 * Math.min(1.6, pullN * (0.35 + 0.65 * next.stam) + 0.2) * stiff * (reel ? 1.4 : 0.8));
    if (!(next.deepT > 0) && !next.airborne) next.events.push({ type: 'splash', x: next.x, z: next.z, big: false });
  }
  next.shake = Math.max(0, next.shake - dt);
  next.deepT = Math.max(0, next.deepT - dt);
  next.deep = lerp(next.deep, next.deepT > 0 ? Math.max(0, Math.min(depthAt(next.x, next.z) - 1, 4 + 8 * str)) : 0, Math.min(1, dt * 0.8));

  const air = next.airborne;
  // What the fish is pulling with right now, in line ratings. A resting fish only hangs on the line.
  const surge = 1 + 0.2 * Math.sin(next.t * 4.1 + next.runAng * 3);
  const fN = next.running ? pullN * (next.pull / str) * surge * (next.deepT > 0 ? 1.25 : 1) : pullN * 0.15 * (0.5 + next.stam);
  next.slipping = next.running && !air && fN > Dn;
  // Cranking adds load, but only as much as the fish gives you something to crank against: a 2 lb
  // snapper offers almost no resistance, so reeling it in never loads the line like reeling a green
  // tuna does. Without this cap a trout on 30 lb line was being "horsed" to 0.5 of rating.
  const horse = Math.min(HORSE * (0.5 + 0.9 * next.stam) * (next.running ? 1 : 0.4), 0.08 + 0.9 * pullN * (0.5 + 0.5 * next.stam));
  let tgt: number;
  if (air) tgt = reel ? 0.9 : 0.04;
  else if (next.running) tgt = Math.min(fN, Dn) + 0.05 + (reel ? horse : 0);
  else tgt = 0.07 + 0.5 * Math.min(fN, Dn) + (reel ? horse : 0);
  next.tension += (tgt - next.tension) * Math.min(1, dt * (tgt > next.tension ? 5 : 2.5));
  next.tension = clamp(next.tension, 0, 1.4);

  let dx = next.x - env.boatX, dz = next.z - env.boatZ;
  const dist = Math.hypot(dx, dz) || 1;
  dx /= dist; dz /= dist;
  if (next.running) {
    // How hard the clutch is being overpowered decides how much line the fish takes; a fish the
    // drag can hold still swims, but cannot peel line.
    const slip = clamp(0.2 + 0.533 * (fN / Math.max(Dn, 0.05) - 0.5), 0.2, 1.3);
    const a = Math.atan2(dz, dx) + next.runAng;
    const sp = (3 + str * 6.5) * (0.4 + 0.6 * next.stam) * slip * (reel ? 0.75 : 1);
    next.x += Math.cos(a) * sp * dt;
    next.z += Math.sin(a) * sp * dt;
  }
  if (reel) {
    const r = params.tackle.reelMs * (0.3 + 0.7 * (1 - next.stam)) * (next.running ? 0.25 : 1) * (1 - Math.min(0.6, fN * 0.5));
    next.x -= dx * r * dt;
    next.z -= dz * r * dt;
  }
  // Fish tire from exertion and from pressure *relative to their own strength*: the same drag
  // wears a 3 lb trout out in seconds and barely troubles a 400 lb marlin.
  const pressureRel = Math.min(2.5, (next.tension * params.ratingLb) / params.forceLb);
  next.stam = Math.max(0, next.stam - dt * (0.02 * (next.running ? 1 : 0.3) + 0.05 * pressureRel) / params.endure);

  // Leader chafe: rises with load and with a fish that is actually running through rock, teeth
  // or structure; a heavier leader resists. It never heals.
  next.abrasion = Math.min(1, next.abrasion + dt * 0.012 * params.rough * (0.3 + 1.2 * next.tension) * (next.running ? 1 : 0.4) * Math.sqrt(30 / params.tackle.leaderLb));
  next.limit = 1 - 0.55 * next.abrasion;

  // Hook wear: always creeping, faster the longer the fight has gone (a hole in a mouth works
  // bigger), quadratic in load above ~0.4 (tearing out), and brutal on slack during a jump or
  // head shake (the hook simply falls out).
  const over = Math.max(0, next.tension - HOOK_TEAR);
  let wear = 0.0045 * (1 + next.t / 40) * (0.4 + (next.running ? 0.4 : 0)) + 0.25 * Math.pow(over, 1.5);
  if (next.tension < SLACK_TENSION && (air || next.shake > 0.05)) wear += 0.4 * (SLACK_TENSION - next.tension) / SLACK_TENSION * (air ? 1.5 : 0.5);
  next.hookHold -= dt * wear * params.hookRisk;
  if (next.hookHold <= 0) { next.hookHold = 0; next.outcome = 'pulled'; return next; }

  if (next.tension >= next.limit) {
    next.overT += dt * (1 + (next.tension - next.limit) * 6);
    if (next.overT > 0.3) { next.outcome = next.abrasion > 0.25 ? 'frayed' : 'snapped'; return next; }
  } else next.overT = Math.max(0, next.overT - dt);

  if (next.tension < 0.05) {
    next.slackT += dt;
    if (next.slackT > 2.2) { next.outcome = 'slack'; return next; }
  } else next.slackT = 0;

  const prevDist = next.dist;
  next.dist = Math.hypot(next.x - env.boatX, next.z - env.boatZ);
  // Line speed is exactly d(dist)/dt, because line length *is* fish-to-boat distance. Positive =
  // paying off the spool. `prevDist === 0` on the first tick (startFight has no distance yet), so
  // that one frame is skipped rather than reporting a spurious 30 m/s from 0 -> dist.
  const rawLineSpeed = prevDist > 0 && dt > 0 ? (next.dist - prevDist) / dt : 0;
  // Smoothed a little: the per-tick delta is noisy (the fish's run heading re-rolls, the boat
  // bobs), and an unsmoothed value makes the drag clicker chatter between rates instead of
  // sweeping. Time-constant ~80 ms — fast enough that the first scream of a run is still sudden.
  const k = Math.min(1, dt / 0.08);
  next.lineSpeed = next.lineSpeed + (rawLineSpeed - next.lineSpeed) * k;
  next.spoolR = spoolRadiusFor(next.dist);
  if (next.dist > params.maxLine) { next.outcome = 'spooled'; return next; }
  if (landH(next.x, next.z) > 0.2) { next.outcome = 'mangrove'; return next; }
  if (rng() < dt * 1.5) next.events.push({ type: 'splash', x: next.x, z: next.z, big: false });
  if (next.dist < 4.5) {
    // A green fish at the boat is not landed, it bolts: you can reel it to the leader and still
    // lose it. Only a worn-out one comes over the gunwale.
    if (next.stam < 0.4) { next.outcome = 'landed'; return next; }
    if (!next.running) {
      next.running = true; next.runT = rand(rng, 1.2, 2.2); next.runAng = rand(rng, -0.6, 0.6);
      next.pull = str * rand(rng, 0.9, 1.1) * (0.45 + 0.55 * next.stam);
      next.events.push({ type: 'splash', x: next.x, z: next.z, big: false }, { type: 'startRun' });
      shock(0.2 * Math.min(1.6, pullN * (next.pull / str)) * stiff * (reel ? 1.2 : 0.35));
    }
  }

  return next;
}
