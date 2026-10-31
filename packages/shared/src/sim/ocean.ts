/**
 * The ocean is alive: fish get smaller where you have been working, and come back when you leave.
 *
 * Today a fish's weight is rolled from the species min/max the moment it is hooked, and the water
 * has no memory. This is the memory, as pure curves. Nothing here stores anything: the caller
 * keeps one number per cell (its `pressure`, as of the last catch) and hands it in together with
 * the hours since that catch. Time is always a parameter, never read from a clock, so the same
 * inputs give the same fish on every client.
 *
 * THE NO-OP RULE. Water nobody has fished has `pressure` 0, which gives recovery exactly 1, which
 * gives both scales exactly 1.0. The model therefore changes nothing for anyone until a cell has
 * actually been fished. That is why the scales only ever go DOWN from 1: "rested water gives bigger
 * fish" is delivered as "fished water gives smaller fish, and rest takes you back to today's
 * fish", never as fish bigger than today's. Going above 1 would change the game for every untouched
 * cell retroactively.
 *
 * Every input is sanitised: NaN, negative and infinite values collapse to the nearest sane value,
 * so a corrupt save or a clock that stepped backwards can never produce a non-finite or
 * out-of-bounds fish.
 */

/**
 * Half-life of pressure: 24 hours. Play terms: work a spot tonight, come back tomorrow evening and
 * only half the fishing-out is left; after a long weekend it is mostly gone. A day is the cadence
 * a player actually has (about one session a day), so "leave it alone overnight" is a real,
 * noticeable choice without making a spot unusable for a week.
 */
export const PRESSURE_HALF_LIFE_HOURS = 24;

/**
 * Pressure at which a cell is 63% depleted (1 - 1/e). One catch is one unit of pressure, so 12
 * catches: roughly ten to fifteen minutes of steady fishing at one spot. A casual handful of fish
 * (3-4) barely shows; an hour of steady work is far past it.
 */
export const PRESSURE_SCALE = 12;

/**
 * Pressure is capped here so one absurd grind (or a corrupt number) cannot bury a cell for a
 * month. 60 catches is about an hour and a half of non-stop fishing. At the 24 h half-life the cap
 * is back under 8 catches (recovery > 0.5) after three days, the longest a spot should stay sour.
 */
export const PRESSURE_CAP = 60;

/**
 * Smallest size multiplier: 0.6. Play terms: in fully fished-out water a 10 lb snapper comes up
 * 6 lb. A 40% haircut is noticed within a few fish, but the spot still produces keepers, so it
 * feels fished-out rather than broken. The species' own min still floors the result
 * (see `applyOceanSize`).
 */
export const SIZE_SCALE_MIN = 0.6;
/** Largest size multiplier: exactly 1.0 (pristine water == today's game). See the no-op rule. */
export const SIZE_SCALE_MAX = 1;

/**
 * Smallest rarity multiplier: 0.35. Play terms: in fished-out water the odds of the good fish
 * (the top of the species range, the ones worth a screenshot) fall to about a third, so a player
 * who hammers one spot stops seeing trophies there long before the average fish visibly shrinks.
 */
export const RARITY_SCALE_MIN = 0.35;
export const RARITY_SCALE_MAX = 1;

/** NaN becomes `fallback`; everything else (including +-Infinity) passes through to be clamped. */
const orElse = (v: number, fallback: number): number => (Number.isNaN(v) ? fallback : v);
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);

/** Pressure left after `hours` of rest. NaN/negative pressure is 0; NaN/negative hours is 0 (no rest). */
export function decayedPressure(pressure: number, hours: number): number {
  const p = clamp(orElse(pressure, 0), 0, PRESSURE_CAP);
  if (p === 0) return 0;
  const h = Math.max(0, orElse(hours, 0)); // a clock that stepped back counts as no rest, not negative rest
  return p * Math.pow(0.5, h / PRESSURE_HALF_LIFE_HOURS);
}

/**
 * Pressure to store after one more catch. `pressure` and `hoursSinceLast` describe the cell as
 * last stored. Decays first, then adds the catch, then caps.
 *
 * `amount` is what that fish was worth (`catchPressure`); it defaults to 1, which is a median
 * fish, so every existing caller and the whole of the tuning above are unchanged.
 */
export function pressureAfterCatch(pressure: number, hoursSinceLast: number, amount = 1): number {
  const a = Number.isFinite(amount) && amount > 0 ? amount : 1;
  return Math.min(PRESSURE_CAP, decayedPressure(pressure, hoursSinceLast) + a);
}

/**
 * How recovered a cell is, 0..1. 1 is pristine (or fully rested); the floor is never quite
 * reached because pressure is capped.
 *
 * Shape: depletion saturates, `1 - exp(-p / 12)`, so the first catches bite and the hundredth
 * barely adds; pressure itself halves every 24 h. A cell worked hard (30 catches, ~40 minutes of
 * steady fishing) starts at recovery 0.08 and reaches 0.5 after about 44 hours: "fish it hard
 * tonight, it is not half back until the day after tomorrow, and mostly back within four days".
 */
export function recovery(pressure: number, hoursSinceLastCaught: number): number {
  const p = decayedPressure(pressure, hoursSinceLastCaught);
  return clamp(Math.exp(-p / PRESSURE_SCALE), 0, 1);
}

/**
 * Multiplier on the baseline size roll, `SIZE_SCALE_MIN..SIZE_SCALE_MAX` (0.6..1.0).
 * The loss goes with the SQUARE of the depletion `d = 1 - r`: a casual three-fish stop (recovery
 * about 0.78) costs 2% of size, which nobody notices; an hour of steady work (recovery 0.09)
 * costs about a third; only a ground-down spot reaches the full 40%.
 */
export function sizeScale(rec: number): number {
  const r = clamp(orElse(rec, 1), 0, 1);
  const d = 1 - r;
  return SIZE_SCALE_MAX - (SIZE_SCALE_MAX - SIZE_SCALE_MIN) * d * d;
}

/**
 * Multiplier on the odds of a good fish, `RARITY_SCALE_MIN..RARITY_SCALE_MAX` (0.35..1.0).
 * The loss goes with depletion to the power 1.5, an earlier onset than size has (size is squared), so the trophies
 * thin out before the average fish visibly shrinks (the same three-fish stop costs about 7% of
 * the trophy odds). That is how fished-out water reads: plenty of small fish, no big ones.
 */
export function rarityScale(rec: number): number {
  const r = clamp(orElse(rec, 1), 0, 1);
  const d = 1 - r;
  return RARITY_SCALE_MAX - (RARITY_SCALE_MAX - RARITY_SCALE_MIN) * d * Math.sqrt(d);
}

/**
 * Apply the size scale to a rolled weight and keep the result inside the species' own range, so
 * wiring this in can never mint a fish the species table says cannot exist.
 */
export function applyOceanSize(weight: number, speciesMin: number, speciesMax: number, rec: number): number {
  const w = orElse(weight, speciesMin) * sizeScale(rec);
  return clamp(w, speciesMin, speciesMax);
}

/**
 * Least and most pressure one fish may be worth. Within a species the natural spread is roughly
 * 0.4 to 1.7 (a 4 lb mutton snapper against a 22 lb one, median 13), so these are guard rails for
 * absurd or missing data rather than limits anyone meets in play.
 */
export const CATCH_MIN = 0.4;
export const CATCH_MAX = 3;

/**
 * What one landed fish costs the water it came from.
 *
 * Every catch used to be worth exactly 1, so a 3 lb grunt thinned a reef as much as the eighty
 * pound grouper that had lived under that ledge for years. Pressure is now the fish's weight
 * against the middle of its own species' range, which keeps the existing tuning exactly where it
 * was — a median fish is still worth 1, so "30 catches" still means pressure 30 — while making a
 * trophy cost the spot more than a schoolie, and comparing each species only against itself (a
 * big snapper is not a small tarpon).
 *
 * Bad or missing species data falls back to 1 rather than to zero: an unrecognised fish is still
 * a fish out of the water.
 */
export function catchPressure(weight: number, min: number, max: number): number {
  const w = orElse(weight, 0), lo = orElse(min, 0), hi = orElse(max, 0);
  const mid = (lo + hi) / 2;
  if (!(w > 0) || !(mid > 0)) return 1;
  return clamp(w / mid, CATCH_MIN, CATCH_MAX);
}
