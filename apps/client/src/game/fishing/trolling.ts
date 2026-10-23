/**
 * Trolling mode: outriggers out, the boat holding seven knots, and a strike that arrives at full
 * speed with no warning.
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
import type { BoatState } from '@keysrun/shared/sim/boat';
import { toast } from '../../ui/toast.js';
import { F } from './state.js';
import { clamp, rand } from '../../core/math.js';

/** Seconds the poles take to swing out or stow. Long enough to watch, short enough not to wait. */
const RIG_SWING_S = 2.4;

export interface TrollingDeps {
  /** The rod's own hookup, reached exactly as the strike window reaches it. */
  setHook(): void;
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
  debug(): { on: boolean; rig: number; quality: number; untilStrike: number; soak: number };
  /**
   * VERIFICATION ONLY: put a fish on now. The soak is 50-140 SIMULATED seconds by design, and
   * this sandbox's simulated clock runs about seven times slower than the wall, so waiting one
   * out in a harness takes the better part of fifteen real minutes. Nothing in normal play
   * reaches this; it skips the clock and nothing else — the species roll, the weight, the
   * hookup and the fight are all the real path.
   */
  debugStrikeNow(boat: BoatState): boolean;
}

export function createTrolling(deps: TrollingDeps): Trolling {
  let state: TrollState = createTrollState();
  let on = false;
  /** 0 stowed, 1 out — eased, so the poles swing rather than snap. */
  let rig = 0;
  /** How well the spread was fishing on the last tick, for the HUD and the harness. */
  let lastQuality = 0;

  function applyRig(): void {
    const set = deps.outriggers();
    if (set) set(rig);
  }

  function strike(boat: BoatState, quality: number): void {
    // Only ever into an idle rod. A trolling strike that interrupted a fish already on, or a cast
    // in the air, would be the game taking the rod off the player.
    if (F.state !== 'idle') return;
    const table = ZONE_TABLE[deps.zone()];
    const key = pickTrollSpecies(table ? table.map(([k]) => k) : [], quality);
    // Nothing in this water would eat a dragged lure. Say nothing and keep fishing — a toast
    // every ninety seconds telling you the snapper are not interested is noise.
    if (!key) return;
    const S = SPECIES[key];
    if (!S) return;

    // The lure is astern, out at the end of the spread. A well-trimmed boat drags it further and
    // straighter, which is also where the outside rods are.
    const back = 26 + rand(0, 22);
    const side = rand(-16, 16);
    const fx = boat.x + Math.sin(boat.h) * back + Math.cos(boat.h) * side;
    const fz = boat.z + Math.cos(boat.h) * back - Math.sin(boat.h) * side;

    // Weight skews heavy with a good spread: trolling is how the big ones are caught, and the
    // trim is the player's input into that.
    const t = clamp(Math.pow(Math.random(), 1 - 0.45 * quality), 0, 1);
    F.key = key;
    F.sp = S;
    F.weight = S.min + (S.max - S.min) * t;
    F.tag = null;
    F.zone = deps.zone();
    F.fx = fx; F.fz = fz;
    F.bob = { x: fx, y: 0, z: fz };
    F.hs = null;

    deps.onStrike(fx, fz);
    toast(`LINE OUT! ${S.name} — ${Math.round(F.weight)} lb on the ${side < 0 ? 'port' : 'starboard'} rigger.`);
    deps.setHook();

    // A trolled fish comes up. That is the whole reason to drag a lure at seven knots rather
    // than sit at anchor: the fish eats at speed, feels the hook against a moving boat, and the
    // first thing it does is clear the water.
    //
    // `startFight` already rolls jumps — 85% for a jumper, 60% for a kingfish, nothing for the
    // rest — so this does not invent a mechanic, it guarantees the roll that a trolling hookup
    // would almost always win anyway, and only for a fish that can actually do it. A grouper
    // dragged out of a wreck still will not fly, and it should not.
    const f = F.fight, pr = F.fightParams;
    if (f && pr && (pr.jump || pr.kingfish)) {
      f.jumpQ = Math.max(f.jumpQ, pr.billfish ? 3 : pr.jump ? 2 : 1);
    }
  }

  return {
    isOn: () => on,
    toggle(boat) {
      on = !on;
      state = setLinesOut(state, on);
      if (on) {
        toast(deps.outriggers()
          ? 'Trolling — outriggers out, holding 7 knots. Lures swim between 5 and 9. 7 again to bring them in.'
          : 'Trolling — lines out, holding 7 knots. This hull has no riggers, so the spread is narrow.');
      } else {
        toast('Lines in.');
        // A fish already on is YOURS: stopping the mode stops the lures, not the fight.
        if (F.state !== 'fight' && F.state !== 'caught') F.state = 'idle';
      }
      void boat;
    },
    off() {
      if (!on) return;
      on = false;
      state = setLinesOut(state, false);
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
      if (!on) return;
      // Nothing is being dragged while a fish is on or a catch card is up — the boat is out of
      // gear and the crew are busy. Soak time stops; the clock does not run down for free.
      if (F.state === 'fight' || F.state === 'caught') return;
      const r = stepTroll(state, { speed: boat.speed, richness: deps.richness() }, dt);
      state = r.state;
      lastQuality = r.quality;
      if (r.strike) strike(boat, r.quality);
    },
    debugStrikeNow(boat) {
      if (!on || F.state !== 'idle') return false;
      strike(boat, trollQuality(boat.speed));
      // `F.state` is narrowed to 'idle' by the guard above, so TypeScript cannot see that
      // `strike` moved it; read it through the object to ask what it actually is now.
      return (F as { state: string }).state === 'fight';
    },
    debug: () => ({
      on,
      rig: +rig.toFixed(3),
      quality: +lastQuality.toFixed(3),
      untilStrike: +state.untilStrike.toFixed(1),
      soak: +state.soak.toFixed(1),
    }),
  };
}

export { TROLL_SPEED_MIN, TROLL_SPEED_MAX, TROLL_SPEED_TARGET };
