/**
 * Trolling mode (+): outriggers out, the boat holding seven knots, and a strike that arrives at
 * full speed with no warning.
 *
 * The rules live in `@keysrun/shared/sim/troll` (the speed window, how long a strike takes, what
 * eats a dragged lure). This is the client half: the throttle hold, the poles, the sound and —
 * the important part — turning a strike into a fight.
 *
 * ## It reuses the rod's own fight, deliberately
 *
 * A trolling hookup calls `fishing.setHook()`, the same function the strike window calls when you
 * hit it on a cast. Everything downstream is then the existing machinery: `fightParamsFor`,
 * `startFight`, the drag, the line, the HUD, the catch card — and the JUMPS, which already exist
 * in `sim/fight.ts` for billfish and other jumpers and needed nothing new. Writing a second fight
 * for trolling would have meant a second set of break-off rules to keep in step with the first.
 *
 * What trolling changes is everything BEFORE the hookup: there is no cast, no float, no nibble
 * and no strike window. The fish hooks itself against the drag at seven knots, which is why the
 * mode skips `waiting`/`nibble`/`bite` and goes straight from idle to a fish on, hard.
 */
import {
  createTrollState, setLinesOut, stepTroll, pickTrollSpecies, trollQuality,
  TROLL_SPEED_TARGET, TROLL_SPEED_MIN, TROLL_SPEED_MAX, type TrollState,
} from '@keysrun/shared/sim/troll';
import { ZONE_TABLE, SPECIES } from '@keysrun/shared/content/species';
import { scaledLenM } from '@keysrun/shared/sim/fight';
import type { BoatState } from '@keysrun/shared/sim/boat';
import { toast } from '../../ui/toast.js';
import { F } from './state.js';
import { RAISE_S } from './troll-raise.js';
import { clamp, rand } from '../../core/math.js';

/** Seconds the poles take to swing out or stow. Long enough to watch, short enough not to wait. */
const RIG_SWING_S = 2.4;

export interface TrollingDeps {
  /** The rod's own hookup, reached exactly as the strike window reaches it. */
  setHook(): void;
  /** How many lures are in the spread, so a raise can pick one of them. */
  spreadCount(): number;
  /** Live world position of lure `station`, or null if the spread is stowed. */
  lurePos(station: number): { x: number; z: number } | null;
  /**
   * A fish has committed and is on its way up to lure `station` — `RAISE_S` seconds before it
   * eats. Cosmetic: the hookup below happens on this module's clock whatever the client draws
   * (game/fishing/troll-raise.ts).
   */
  onRaise(color: string, lenM: number, station: number): void;
  /** The raise is over, eaten or abandoned. */
  onRaiseEnd(): void;
  /**
   * It ate: haul lure `station` under. A trolled fish does not nibble — it takes the bait going
   * the other way at speed, and the bait disappearing is the first thing anyone aboard sees.
   */
  onEaten(station: number): void;
  /** Swing the outriggers; null on a hull with nothing to bolt them to. */
  outriggers(): ((t: number) => void) | null;
  /** The zone the boat is in right now, keyed into `ZONE_TABLE`. */
  zone(): string;
  /** Richness of the water under the boat — a weedline or a hump fishes faster. 1 is open water. */
  richness(): number;
  /** A splash where the lure was, and a jolt. */
  onStrike(x: number, z: number): void;
}

export interface Trolling {
  isOn(): boolean;
  /** True while the mode wants the throttle held — see `wantThrottle`. */
  toggle(boat: BoatState): void;
  off(): void;
  /**
   * Bang-bang throttle hold. The boat's own input is binary (`fwd` on or off), so holding a
   * SPEED rather than a throttle position means pulsing it: open below the target, closed above.
   * A PID would be the textbook answer and would also be inaudible — the engine note surging
   * gently up and down is what a trolling boat actually sounds like.
   */
  wantThrottle(boat: BoatState): boolean;
  update(dt: number, boat: BoatState): void;
  /** VERIFICATION ONLY. */
  /** How far the gear is deployed, 0 stowed to 1 fully out — the same eased number the poles
   * swing on, so the spread in the water comes out with them (game/fishing/troll-spread.ts). */
  rigOut(): number;
  debug(): { on: boolean; rig: number; quality: number; untilStrike: number; soak: number; raising: number };
  /**
   * VERIFICATION ONLY: put a fish on now. The soak is 50-140 SIMULATED seconds by design, and
   * this sandbox's simulated clock runs about seven times slower than the wall, so waiting one
   * out in a harness takes the better part of fifteen real minutes. Nothing in normal play
   * reaches this; it skips the clock and nothing else — the species roll, the weight, the
   * hookup and the fight are all the real path.
   */
  debugStrikeNow(boat: BoatState): boolean;
  /**
   * VERIFICATION ONLY: start a raise and let it run its full `RAISE_S`, so the approach can
   * actually be watched. `debugStrikeNow` deliberately skips it; this is the other half.
   */
  debugRaiseNow(boat: BoatState): boolean;
  /**
   * How far through a raise we are, 0..1, or -1 when nothing is coming up. The client's approach
   * animation runs off THIS rather than its own timer, so what you watch arrive and what the
   * rules hook are the same instant — see game/fishing/troll-raise.ts's `update`.
   */
  raiseProgress(): number;
}

export function createTrolling(deps: TrollingDeps): Trolling {
  let state: TrollState = createTrollState();
  let on = false;
  /** 0 stowed, 1 out — eased, so the poles swing rather than snap. */
  let rig = 0;
  /** How well the spread was fishing on the last tick, for the HUD and the harness. */
  let lastQuality = 0;
  /** The fish that has committed but not yet got there — see `raiseFish`. */
  let pending: { key: string; S: (typeof SPECIES)[string]; weight: number; station: number } | null = null;
  /** Seconds left of the raise. Counts down in `update`; the eat happens at zero. */
  let raiseLeft = 0;

  function applyRig(): void {
    const set = deps.outriggers();
    if (set) set(rig);
  }

  /**
   * A fish has decided to eat. It is not on yet.
   *
   * Everything that decides the catch happens HERE — the species roll, the weight roll, which
   * lure gets worked — and is then held in `pending` for `RAISE_S` while the client draws it
   * coming up. Rolling at the top of the raise rather than at the eat is what lets the fish you
   * watch climb be the fish you hook: `troll-raise.ts` is handed the real species colour and the
   * real scaled length, so a 600 lb bluefin comes up the size of a 600 lb bluefin.
   */
  function raiseFish(boat: BoatState, quality: number): void {
    // Only ever into an idle rod. A trolling strike that interrupted a fish already on, or a cast
    // in the air, would be the game taking the rod off the player.
    if (F.state !== 'idle' || pending) return;
    const table = ZONE_TABLE[deps.zone()];
    const key = pickTrollSpecies(table ? table.map(([k]) => k) : [], quality);
    // Nothing in this water would eat a dragged lure. Say nothing and keep fishing — a toast
    // every ninety seconds telling you the snapper are not interested is noise.
    if (!key) return;
    const S = SPECIES[key];
    if (!S) return;

    // Weight skews heavy with a good spread: trolling is how the big ones are caught, and the
    // trim is the player's input into that.
    const t = clamp(Math.pow(Math.random(), 1 - 0.45 * quality), 0, 1);
    const weight = S.min + (S.max - S.min) * t;

    // Which bait gets eaten. The long riggers carry the outside baits and are what a fish coming
    // up the wake meets first, so they take the larger share — but a flat line down the prop wash
    // gets hit often enough that watching only the riggers is a mistake.
    const n = Math.max(1, deps.spreadCount());
    const station = n >= 4 && Math.random() < 0.62 ? (Math.random() < 0.5 ? 0 : 1) : Math.floor(Math.random() * n);

    pending = { key, S, weight, station };
    raiseLeft = RAISE_S;
    deps.onRaise(S.color, scaledLenM(key, weight), station);

    // The mate's call. Without it the feature is invisible in ordinary play: the chase camera
    // looks forward over the bow, which puts the whole spread at the bottom edge of the screen,
    // so a fish coming up 30 m astern happens off-camera unless you already knew to look.
    //
    // It names the position and nothing else, which is both what actually gets shouted on a boat
    // and the right amount of information — you get told where to look, and what it is is still
    // something you find out by looking. The species and the weight stay in the `LINE OUT!`
    // toast at the eat.
    toast(`${sideName(boat, station)} — FISH UP!`);
  }

  /** Which bait, as it would be called out: the riggers carry the outside baits, the flat lines
   * run down the prop wash, and port/starboard comes from where the lure actually is. */
  function sideName(boat: BoatState, station: number): string {
    const at = deps.lurePos(station);
    const starboard = at ? (at.x - boat.x) * Math.cos(boat.h) + (at.z - boat.z) * -Math.sin(boat.h) > 0 : station % 2 === 1;
    return `${starboard ? 'Starboard' : 'Port'} ${station < 2 ? 'rigger' : 'flat line'}`;
  }

  /** The eat. `pending` becomes a fish on, at wherever its lure has got to by now. */
  function commit(boat: BoatState): void {
    const p = pending;
    pending = null;
    raiseLeft = 0;
    if (!p || F.state !== 'idle') { deps.onRaiseEnd(); return; }

    // Where the bait actually is, not where it was when the fish started up — the boat has run
    // the better part of six metres during the raise, usually while turning. The fallback only
    // fires if the spread went away underneath us (lines in mid-raise), in which case astern of
    // the boat is the honest answer.
    const at = deps.lurePos(p.station);
    const fx = at ? at.x : boat.x + Math.sin(boat.h) * (26 + rand(0, 22));
    const fz = at ? at.z : boat.z + Math.cos(boat.h) * (26 + rand(0, 22));

    F.key = p.key;
    F.sp = p.S;
    F.weight = p.weight;
    F.tag = null;
    F.zone = deps.zone();
    F.fx = fx; F.fz = fz;
    F.bob = { x: fx, y: 0, z: fz };
    F.hs = null;

    // The bait goes under before anything else happens, because that is the order it happens in.
    deps.onEaten(p.station);
    deps.onStrike(fx, fz);
    toast(`LINE OUT! ${p.S.name} — ${Math.round(p.weight)} lb on the ${sideName(boat, p.station).toLowerCase()}.`);
    deps.setHook();

    // A trolled fish comes up. That is the whole reason to drag a lure at seven knots rather
    // than sit at anchor: the fish eats at speed, feels the hook against a moving boat, and the
    // first thing it does is clear the water.
    //
    // `startFight` already rolls jumps — 85% for a jumper, 60% for a kingfish, nothing for the
    // rest — so this does not invent a mechanic, it guarantees the roll that a trolling hookup
    // would almost always win anyway, and only for a fish that can actually do it. A grouper
    // dragged out of a wreck still will not fly, and it should not.
    // Only fish that actually jump, jump. A tuna hit at seven knots goes DOWN and sideways and
    // keeps going — that is the whole character of the fight — and dragging it into the air
    // would be a lie about the one species this mode catches most.
    const f = F.fight, pr = F.fightParams;
    if (f && pr && (pr.jump || pr.kingfish)) {
      f.jumpQ = Math.max(f.jumpQ, pr.billfish ? 3 : pr.jump ? 2 : 1);
    }

    // LAST, after `setHook`. The climbing fish is swapped for the hooked one on the same frame
    // rather than a frame early, and it lets the client tell a hookset that already had a camera
    // on it from one that needs a fresh cut — see world.ts's `raiseCamShot`.
    deps.onRaiseEnd();
  }

  /** Give up on a raise without a hookup — lines in, or the rod got busy some other way. */
  function abortRaise(): void {
    if (!pending) return;
    pending = null;
    raiseLeft = 0;
    deps.onRaiseEnd();
  }

  return {
    rigOut: () => rig,
    isOn: () => on,
    toggle(boat) {
      on = !on;
      state = setLinesOut(state, on);
      if (on) {
        toast(deps.outriggers()
          ? 'Trolling — outriggers out, holding 7 knots. Lures swim between 5 and 9. + again to bring them in.'
          : 'Trolling — lines out, holding 7 knots. This hull has no riggers, so the spread is narrow.');
      } else {
        toast('Lines in.');
        // A fish on its way up to a lure that is being winched out of the water does not get
        // there. No toast — it never announced itself, so it has nothing to take back.
        abortRaise();
        // A fish already on is YOURS: stopping the mode stops the lures, not the fight.
        if (F.state !== 'fight' && F.state !== 'caught') F.state = 'idle';
      }
      void boat;
    },
    off() {
      if (!on) return;
      on = false;
      state = setLinesOut(state, false);
      abortRaise();
    },
    wantThrottle(boat) {
      if (!on) return false;
      // A touch of hysteresis around the target, or the engine hunts audibly at 30 Hz.
      return Math.abs(boat.speed) < TROLL_SPEED_TARGET - (Math.abs(boat.speed) > TROLL_SPEED_MIN ? 0.12 : 0);
    },
    update(dt, boat) {
      const want = on ? 1 : 0;
      if (rig !== want) {
        rig = want > rig ? Math.min(1, rig + dt / RIG_SWING_S) : Math.max(0, rig - dt / RIG_SWING_S);
        applyRig();
      }
      if (!on) {
        abortRaise();
        return;
      }
      // A fish already on the way up takes precedence over the soak clock: the lures are busy,
      // so nothing else can decide to eat until this one has or hasn't.
      if (pending) {
        raiseLeft -= dt;
        // The rod got busy some other way mid-raise (a cast hooked up). Let it go rather than
        // stacking a second fish onto the same rod.
        if (F.state !== 'idle') abortRaise();
        else if (raiseLeft <= 0) commit(boat);
        return;
      }
      // Nothing is being dragged while a fish is on or a catch card is up — the boat is out of
      // gear and the crew are busy. Soak time stops; the clock does not run down for free.
      if (F.state === 'fight' || F.state === 'caught') return;
      const r = stepTroll(state, { speed: boat.speed, richness: deps.richness() }, dt);
      state = r.state;
      lastQuality = r.quality;
      if (r.strike) raiseFish(boat, r.quality);
    },
    debugStrikeNow(boat) {
      if (!on || F.state !== 'idle') return false;
      // Skips the raise as well as the clock — the harness wants a fish on, not an animation.
      raiseFish(boat, trollQuality(boat.speed));
      commit(boat);
      // `F.state` is narrowed to 'idle' by the guard above, so TypeScript cannot see that
      // `commit` moved it; read it through the object to ask what it actually is now.
      return (F as { state: string }).state === 'fight';
    },
    raiseProgress: () => (pending ? clamp(1 - raiseLeft / RAISE_S, 0, 1) : -1),
    debugRaiseNow(boat) {
      if (!on || F.state !== 'idle' || pending) return false;
      raiseFish(boat, trollQuality(TROLL_SPEED_TARGET));
      return pending !== null;
    },
    debug: () => ({
      on,
      rig: +rig.toFixed(3),
      quality: +lastQuality.toFixed(3),
      untilStrike: +state.untilStrike.toFixed(1),
      raising: +Math.max(0, raiseLeft).toFixed(2),
      soak: +state.soak.toFixed(1),
    }),
  };
}

export { TROLL_SPEED_MIN, TROLL_SPEED_MAX, TROLL_SPEED_TARGET };
