/**
 * Treasure in the wrecks: what is lying in the sand around each hull, what opening it pays, and
 * the one state transition that empties it for good.
 *
 * Pure and three-free (CI: check:no-three) like the rest of `sim/`, in the house `step*(state,
 * input) => state` shape, because "this container paid you $1,340" is exactly the kind of claim
 * docs/ARCHITECTURE.md puts on the server eventually. The client half (the encrusted boxes you
 * actually swim up to, and the localStorage that remembers what you emptied) is
 * apps/client/src/entities/life/wreck-treasure.ts.
 *
 * ## Why it lives in sim/ and not world/
 *
 * `world/wrecks.ts` answers "where is the steel" and is pure world content: a seed and the
 * bathymetry decide it, and every client computes the same answer forever. Treasure is two
 * different things stapled together — a *placement* (world content, derived from the wreck, same
 * for everybody) and a *payout plus a looted flag* (player progress and money, which a server has
 * to arbitrate). The payout half is the half that matters, so the whole thing sits in sim/ and
 * imports the wreck table rather than the other way round. Nothing in world/ knows this file
 * exists.
 *
 * ## Why the containers are in the sand, not in the hold
 *
 * There is no interior collision on a wreck — the hulls are lofted shells you can swim through
 * (entities/life/wreck-geometry.ts). A strongbox "in the deckhouse" would therefore be a box
 * floating inside a dark shell, invisible from outside and reachable only by accident. So every
 * container lies on the seabed within a few metres of the hull's side, in the scour: which is
 * also where a century of surge and the sinking itself actually puts deck cargo. You find treasure
 * by swimming the length of a wreck along the bottom, which is what a diver on a breath-hold
 * budget does anyway.
 *
 * Rejected: scattering containers over a wide radius so they have to be *searched* for. With
 * 10-30 m of visibility and a 40-120 s breath, a 60 m search radius means swimming past nothing,
 * surfacing, and concluding the feature is broken.
 *
 * ## The money (and why these numbers)
 *
 * content/venues.ts's PRICING note sets the unit: a design "session" is ~$3.75k at the Reef and
 * ~$6.3k offshore, i.e. roughly $250 per effective minute inshore. Against that:
 *
 *  - The whole world holds `TOTAL_CASH_BAND` ($9k-$16k) in treasure, across six wrecks, ONCE — a
 *    looted wreck is empty forever. Measured over five seeds it comes out at $10.5k-$11.2k, i.e.
 *    about three Reef sessions of rod income: enough to put the pony bottle (4,500) or the lever
 *    reel (4,000) within reach of a player who would rather dive than troll, and nowhere near
 *    enough to skip the shops — braid130, a hull and the dive kit together are an order of
 *    magnitude more.
 *  - A single container pays $70-$1,800 depending on kind and depth, i.e. between a yellowtail and
 *    a decent marlin (sim/economy.ts's `fishValue`). A whole wreck is worth ~$870 (the plane, in
 *    7 m, which a snorkeller can empty on two breaths) to ~$4,360 (the deep freighter in 62 m,
 *    which needs the bottle and most of a fill). Depth is the difficulty dial, so depth is the pay
 *    dial: `depthMul` below.
 *  - Ammo is deliberately thin: 110-140 rounds in the whole world against the gun counter's $75
 *    box of 50. A found can is a welcome top-up and never a supply line, so the box stays worth
 *    buying (the inert-shop-item failure test/shop.test.ts exists to prevent).
 *
 * Rejected: paying by *weight* like the cooler, so you had to surface with it. It needs a carry
 * state, a drop-on-blackout rule and a second weigh-in path, for the gain of one more inventory
 * screen. Rejected: a gem/relic table with its own rarities — the money is the reward, and a
 * second currency nobody can spend is the thing this codebase already deleted once (fuel cans).
 *
 * The valuables are named (`Loot.label`) but credit their value the moment you prise the box
 * open, exactly as a landed fish credits `fishValue` the moment it is in the boat. Stated plainly
 * because it IS an abstraction: there is no pawn-shop sell flow, and Keys Pawn & Loan ("We buy
 * gold · No questions") is the obvious place for one if that trade ever stops feeling fine.
 */
import { hashCell } from '../rng/index.js';
import { depthAt } from '../world/depth.js';
import { reliefAt } from '../world/relief.js';
import { wreckPoint, type Wreck } from '../world/wrecks.js';
import { AMMO_KEY } from './handgun.js';
import { countOf, type Inventory } from './shop.js';

/**
 * What a container is. Four kinds, because each one answers a different question:
 *   strongbox  the ship's cash box — the big one, one per wreck, the reason to swim the whole hull
 *   coins      a spill of silver coins and ballast, half-buried: the mid-value find
 *   crate      a burst cargo crate — modest, and sometimes has a few loose rounds in it
 *   ammocan    a steel ammunition can, green with verdigris: the pistol's reason to dive
 */
export type ContainerKind = 'strongbox' | 'coins' | 'crate' | 'ammocan';

export interface Container {
  /** `<wreckId>:<n>` — stable forever: the count comes from the wreck's own `mass`, so adding a
   * wreck (or editing another one) can never renumber this one's containers. The looted set is
   * keyed on it, which is why that matters more here than anywhere else. */
  id: string;
  wreckId: string;
  kind: ContainerKind;
  /** World position on the seabed (the seabed y is the client's job: it samples the terrain mesh
   * the same way entities/life/wrecks.ts places the hulls and their debris). */
  x: number;
  z: number;
  /** Which way it came to rest, radians. Cosmetic. */
  yaw: number;
  /** 0..1 — how deep into the sand it has settled, as a fraction of its own height. A coin spill
   * is nearly gone; a strongbox sits proud. */
  buried: number;
  /** Metres from the hull's side it lies (diagnostic, and what the client's "is it under the
   * overhang" judgement would read if it ever wanted one). */
  standoffM: number;
  /** Metres the real floor stands above the smooth bathymetry here (`reliefAt`) — how rocky the
   * ground it came to rest on is. Kept because it is what the site search below minimised, so a
   * test can assert the result rather than the search. */
  reliefM: number;
}

export interface Loot {
  /** Dollars, credited on opening. */
  cash: number;
  /** Rounds of `handgun.ammo`. */
  ammo: number;
  /** What it actually was, for the toast. Flavour only — the cash is the reward. */
  label: string;
}

const SALT = {
  KIND: 7701, U: 7702, SIDE: 7703, OFF: 7704, YAW: 7705, BURIED: 7706,
  CASH: 7710, AMMO: 7711, LABEL: 7712, CRATE_AMMO: 7713,
} as const;

/**
 * How flat the ground has to be for a container to come to rest on it, and how many sites it
 * tries before taking the flattest one it saw.
 *
 * A wreck's own placement only checks relief across the HULL's footprint (world/wrecks.ts's
 * `maxRelief`), and these lie metres outside it. On the reef wrecks that is enough to put a
 * strongbox inside a coral head — verified with screenshots twice over. The first version tested
 * a single point and still lost the tug's ammo can: it found a 0.8 m hollow that was a *crevice
 * between* two 3 m heads, which from 3 m away is a box you cannot see at all. So the test is a
 * footprint, exactly like the hull's: the centre has to be flat ground AND the ring around it has
 * to be ground rather than a wall.
 *
 * 0.6 m is "a sand patch or low rubble, not structure" (relief.ts's own sand-wave term is 0.15 m
 * and its coral heads start around 2 m); 0.9 m of range across a 3.2 m circle is a seabed that
 * slopes, not one with something standing on it.
 */
const MAX_SITE_RELIEF_M = 0.6;
const MAX_SITE_RANGE_M = 0.9;
const SITE_ATTEMPTS = 26;
/** Radius of the clearance ring, metres: a bit more than a container is wide, so "clear" means
 * you can see and reach it, not that it happens to be wedged in a gap. */
const SITE_RING_M = 1.6;
/**
 * Metres two containers on the same wreck must stay apart. Comfortably more than `REACH_M`, so
 * exactly one is ever in reach and the prompt cannot flicker between two boxes you are standing
 * between — which is what happened on the tug the first time the standoff was widened.
 *
 * This is the one thing a container's site depends on besides (seed, wreck, index, attempt): it
 * also avoids the ones already placed on the same hull. That costs the property that placing
 * container 2 cannot move container 3 — but a wreck's container COUNT is a pure function of its
 * own `mass`, so the only edit that can renumber a hull is one that changes that wreck, which
 * reshuffles its treasure anyway.
 */
const MIN_SEPARATION_M = 6;

/** How bad a site is: 0 = flat sand with flat sand around it. The centre's own relief and the
 * range across the ring, which is the thing that catches a crevice. */
function siteCost(x: number, z: number): { cost: number; relief: number } {
  const r0 = reliefAt(x, z, depthAt(x, z));
  let lo = r0, hi = r0;
  for (let a = 0; a < 4; a++) {
    const px = x + Math.cos(a * Math.PI / 2) * SITE_RING_M, pz = z + Math.sin(a * Math.PI / 2) * SITE_RING_M;
    const r = reliefAt(px, pz, depthAt(px, pz));
    if (r < lo) lo = r;
    if (r > hi) hi = r;
  }
  const range = hi - lo;
  return { cost: Math.max(0, Math.abs(r0) - MAX_SITE_RELIEF_M) + Math.max(0, range - MAX_SITE_RANGE_M) + range * 0.25 + Math.abs(r0) * 0.25, relief: r0 };
}

/** Containers per wreck. Capped at 5: past that a wreck is a chore, and the fish are the reason
 * to be there in the first place. */
export const containerCount = (w: Wreck): number => Math.min(5, 2 + Math.floor(w.mass));

/** Base dollars by kind, before depth. See the header for the band these add up to. */
const CASH_BASE: Readonly<Record<ContainerKind, number>> = {
  strongbox: 600, coins: 345, crate: 215, ammocan: 80,
};

/**
 * Depth is the difficulty, so depth is the pay: 7 m (one breath, no gear) x0.85, 14 m x1.1,
 * 21 m (a real free-dive) x1.35, 35 m x1.85, 62 m (bottle, narcosis, a long way from the
 * surface) x2.8 — a 3.3x spread across the six wrecks.
 *
 * The offset started at 1.0 (a flat 1 + depth/34, a 2.2x spread) and the shallow plane came out at
 * ~$1,070 for a thirty-second snorkel, which is better per minute than the deep freighter that
 * needs $4,500 of air to reach. Pulling the intercept below 1 makes the gear the thing that opens
 * the paying wrecks, which is what the dive shop is for.
 */
const depthMul = (w: Wreck): number => 0.6 + w.seaDepth / 28;

/** Kind of container `i`, after the first. Coins are commonest (a spill is what survives a
 * century), cans rarest. */
const KIND_TABLE: ReadonlyArray<readonly [ContainerKind, number]> = [['coins', 3], ['crate', 2.5], ['ammocan', 1.6]];

function pickKind(h: number): ContainerKind {
  let total = 0;
  for (const [, w] of KIND_TABLE) total += w;
  let r = h * total;
  for (const [k, w] of KIND_TABLE) { r -= w; if (r <= 0) return k; }
  return 'coins';
}

/**
 * Every container on one wreck, in world coordinates. Pure in `(seed, wreck)`; the per-wreck cache
 * is only to keep a 2 Hz proximity scan from re-deriving 20 of these.
 *
 * Index 0 is always the strongbox, and a wreck with three or more containers is guaranteed at
 * least one ammo can. Both are deliberate overrides of the roll, not accidents of it: if the roll
 * is left alone, some wrecks hold nothing but crates, and a player who dives two of those reads
 * the whole feature — and the "find ammo in a wreck" half especially — as not working.
 */
const _cache = new Map<string, readonly Container[]>();

export function containersFor(seed: number, w: Wreck): readonly Container[] {
  const ck = `${seed}:${w.id}`;
  const hit = _cache.get(ck);
  if (hit) return hit;
  const n = containerCount(w);
  const out: Container[] = [];
  for (let i = 0; i < n; i++) {
    const kind: ContainerKind = i === 0 ? 'strongbox' : pickKind(hashCell(seed, w.index, i, SALT.KIND));
    let best: { x: number; z: number; standoffM: number; reliefM: number; cost: number } | null = null;
    for (let k = 0; k < SITE_ATTEMPTS; k++) {
      // The attempt index is the only loop variable (world/wrecks.ts's rule): a site is a pure
      // function of (seed, wreck, container index, attempt), so re-running the search can never
      // depend on what was placed before it.
      const c = i * 32 + k;
      // Spread along the hull: one container per band, jittered inside it, so you never get three
      // in a heap and never a 120 m hull with everything at the stern. +-0.46 of the hull's length
      // keeps them beside the steel rather than off either end.
      const u = -0.46 + 0.92 * ((i + hashCell(seed, w.index, c, SALT.U)) / n);
      const side = hashCell(seed, w.index, c, SALT.SIDE) < 0.5 ? -1 : 1;
      // Metres clear of the hull's side, not beams: a 7.5 m tug and a 29 m wingspan want the same
      // "just outside the plating" look, and 3-7 m is inside the fog at every wreck depth.
      const standoffM = 3 + 8 * hashCell(seed, w.index, c, SALT.OFF);
      const p = wreckPoint(w, u, side * (0.5 + standoffM / w.beam));
      let sep = Infinity;
      for (const q of out) sep = Math.min(sep, Math.hypot(p.x - q.x, p.z - q.z));
      const { cost, relief } = siteCost(p.x, p.z);
      const total = cost + Math.max(0, MIN_SEPARATION_M - sep);
      if (!best || total < best.cost) best = { x: p.x, z: p.z, standoffM, reliefM: relief, cost: total };
      if (total <= 0) break;
    }
    const site = best!;
    out.push({
      id: `${w.id}:${i}`, wreckId: w.id, kind, x: site.x, z: site.z, standoffM: site.standoffM, reliefM: site.reliefM,
      yaw: hashCell(seed, w.index, i, SALT.YAW) * Math.PI * 2,
      // How far into the sand it has settled, as a fraction of its own height. A strongbox or a
      // can has a third of itself dug in; a coin spill is only 13 cm tall to begin with, so the
      // same fraction would put it under the sand entirely - it gets a quarter, and what shows is
      // a low mound with coins on it.
      buried: kind === 'coins' ? 0.25 + 0.25 * hashCell(seed, w.index, i, SALT.BURIED)
        : 0.2 + 0.35 * hashCell(seed, w.index, i, SALT.BURIED),
    });
  }
  if (n >= 3 && !out.some((c) => c.kind === 'ammocan')) out[n - 1] = { ...out[n - 1], kind: 'ammocan' };
  const frozen: readonly Container[] = out;
  _cache.set(ck, frozen);
  return frozen;
}

const COIN_LABELS = ['a fistful of silver reales, fused into a green brick', 'a sock of silver coins the sand had kept', 'a spill of coins and ballast stone'];
const BOX_LABELS = ['the purser\'s strongbox, hinges gone', 'a bronze-bound cash box', 'the ship\'s box: coin, a gold chain, a sodden ledger'];
const CRATE_LABELS = ['a burst crate of brass fittings', 'a crate of ship\'s tools, one sextant surviving', 'a crate of copper sheathing'];
const CAN_LABELS = ['a steel ammunition can, half the rounds still dry', 'an ammo can, verdigris an inch thick'];

/**
 * What one container holds. Pure in `(seed, container)` — the same wreck holds the same treasure
 * this session, next session and on anyone else's machine, which is the whole point.
 *
 * `depthMul` needs the wreck, and the container does not carry its own depth (it is the wreck's),
 * so this takes both. Callers that have a `Container` from `containersFor(seed, w)` have the `w`.
 */
export function lootOf(seed: number, w: Wreck, c: Container): Loot {
  const i = Number(c.id.slice(c.id.lastIndexOf(':') + 1));
  const jitter = 0.8 + 0.45 * hashCell(seed, w.index, i, SALT.CASH);
  const cash = Math.round(CASH_BASE[c.kind] * depthMul(w) * jitter);
  const ah = hashCell(seed, w.index, i, SALT.AMMO);
  // A can is 16-35 rounds (the gun counter sells 50 for $75); a crate has loose rounds about a
  // third of the time. A strongbox and a coin spill have none — money is their whole job.
  const ammo = c.kind === 'ammocan' ? 16 + Math.floor(ah * 20)
    : c.kind === 'crate' && hashCell(seed, w.index, i, SALT.CRATE_AMMO) < 0.34 ? 4 + Math.floor(ah * 7)
      : 0;
  const labels = c.kind === 'strongbox' ? BOX_LABELS : c.kind === 'coins' ? COIN_LABELS : c.kind === 'crate' ? CRATE_LABELS : CAN_LABELS;
  return { cash, ammo, label: labels[Math.floor(hashCell(seed, w.index, i, SALT.LABEL) * labels.length) % labels.length] };
}

/** The band `totalTreasureCash` must stay inside, asserted in test/treasure.test.ts. Written down
 * here rather than only in the test so a future tuning pass has to argue with the number: below
 * $9k the dive is not worth the swim, above $16k it starts to replace fishing. */
export const TOTAL_CASH_BAND: readonly [number, number] = [9_000, 16_000];

/** Every dollar of treasure in a world, for balance tests and for the economy note above. */
export function totalTreasureCash(seed: number, wrecks: readonly Wreck[]): number {
  let sum = 0;
  for (const w of wrecks) for (const c of containersFor(seed, w)) sum += lootOf(seed, w, c).cash;
  return sum;
}

/** Every round of pistol ammo in a world. Same purpose. */
export function totalTreasureAmmo(seed: number, wrecks: readonly Wreck[]): number {
  let sum = 0;
  for (const w of wrecks) for (const c of containersFor(seed, w)) sum += lootOf(seed, w, c).ammo;
  return sum;
}

/* ------------------------------------------------------------------------------------------ *
 * What has been emptied — the one piece of state
 * ------------------------------------------------------------------------------------------ */

/**
 * The looted set.
 *
 * **Why it is its own state and not part of the container generation.** `containersFor` is world
 * content: a pure function of the seed, identical on every machine forever, and that is what makes
 * "the same wreck holds the same treasure every session" true. Whether *you* have already emptied
 * a box is the opposite kind of fact — it is player progress, it differs per player, it changes at
 * runtime, and in a shared world the server has to arbitrate it (two divers cannot both take the
 * same strongbox). Folding it into the generator would mean a seed no longer determines the world.
 * This is the same split `entities/life/wreck-chart.ts` already makes between where a wreck *is*
 * and whether you have *found* it, for the same reasons.
 *
 * So: the transition is here, pure and liftable; the storage is the client's localStorage seam
 * (entities/life/treasure-store.ts), which is no more authoritative than the wallet or the chart
 * and says so.
 *
 * A string array rather than a Set so it is JSON straight out, like `Inventory.gear`.
 */
export interface TreasureState {
  opened: readonly string[];
}

export const createTreasureState = (): TreasureState => ({ opened: [] });

export const isOpened = (s: TreasureState, containerId: string): boolean => s.opened.includes(containerId);

export interface OpenInput {
  seed: number;
  wreck: Wreck;
  container: Container;
}

export interface OpenResult {
  /** The same reference when nothing changed (it was already empty), so a caller can tell cheaply
   * whether it needs to persist anything — the convention `useOne` and `pruneBuffs` use. */
  state: TreasureState;
  /** Null when it was already empty. */
  loot: Loot | null;
}

/** Opens one container. Pure; the caller credits the cash and the ammo (`applyLoot`) and persists
 * the returned state. */
export function stepOpenContainer(state: TreasureState, input: OpenInput): OpenResult {
  const { seed, wreck, container } = input;
  if (isOpened(state, container.id)) return { state, loot: null };
  return { state: { opened: [...state.opened, container.id] }, loot: lootOf(seed, wreck, container) };
}

/** Puts a loot's ammo in the player's inventory. The cash is the wallet's business (sim/economy.ts
 * owns that; `credit` on the client's economy system), which is why this returns only an
 * Inventory — same division of labour as `buy`, which never touches the wallet either. */
export function applyLoot(inv: Inventory, loot: Loot): Inventory {
  if (loot.ammo <= 0) return inv;
  return { ...inv, consumables: { ...inv.consumables, [AMMO_KEY]: countOf(inv, AMMO_KEY) + loot.ammo } };
}

/* ------------------------------------------------------------------------------------------ *
 * Proximity — what the diver can reach right now
 * ------------------------------------------------------------------------------------------ */

/**
 * How close the diver has to be to prise a container open, metres (3D).
 *
 * 3.5 m is arm's reach plus the slop of a body that is always drifting: tight enough that you have
 * to go *to* the box (and spend the air doing it), loose enough that you are not fighting the
 * surge for a pixel-perfect position with 8 s of breath left. The town's interact radius
 * (world/town.ts) is the same idea at walking scale.
 */
export const REACH_M = 3.5;

/** Range at which an unopened container is worth telling the player about, metres. Well inside
 * underwater visibility, so the hint never points at something invisible. */
export const NOTICE_M = 14;

export interface NearContainer {
  container: Container;
  wreck: Wreck;
  /** 3D distance, metres. `floorY` is the caller's seabed sample, so this is honest about height:
   * swimming 20 m above a strongbox must not count as standing on it. */
  dist: number;
}

/**
 * The nearest unopened container to a point, within `r`. `floorYAt` is the seabed height at a
 * world (x,z) — the client passes its terrain sampler, tests pass a constant.
 *
 * O(containers), which is 20 in the whole world; the client still only calls it for wrecks it is
 * already near.
 */
export function nearestUnopened(
  seed: number, wrecks: readonly Wreck[], state: TreasureState,
  x: number, y: number, z: number, r: number,
  floorYAt: (x: number, z: number) => number,
): NearContainer | null {
  let best: NearContainer | null = null;
  let bd = r;
  for (const w of wrecks) {
    for (const c of containersFor(seed, w)) {
      if (isOpened(state, c.id)) continue;
      // Cheap plan-distance reject first: `floorYAt` is the client's real terrain sampler (a
      // depth-grid lookup plus the closed-form relief), and this runs every frame while diving.
      const flat = Math.hypot(x - c.x, z - c.z);
      if (flat >= bd) continue;
      const d = Math.hypot(flat, y - floorYAt(c.x, c.z));
      if (d < bd) { bd = d; best = { container: c, wreck: w, dist: d }; }
    }
  }
  return best;
}

/** The player-facing line for a container in reach. The kind is named so the prompt reads as a
 * thing in the world rather than a generic "use". */
export function reachPrompt(c: Container): string {
  const what = c.kind === 'strongbox' ? 'strongbox' : c.kind === 'coins' ? 'coin spill' : c.kind === 'crate' ? 'cargo crate' : 'ammunition can';
  return `F  Prise open the ${what}`;
}
