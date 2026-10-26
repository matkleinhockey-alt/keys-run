/**
 * Plain-data types for the fish simulation.
 *
 * Per docs/ARCHITECTURE.md's fish-ownership note ("structure your code so a school's state is
 * separable from its rendering ... so the sim agent can lift the simulation server-side later
 * without a rewrite") and its general convention ("simulation functions are
 * step*(state, input, dt) -> state with plain {x,y,z} objects — never THREE.Vector3"),
 * `SchoolState` and everything it references is plain JSON-serialisable data: no three.js, no
 * DOM. `stepSchool` (school.ts) only ever touches these types; `renderSchool` (render.ts) is the
 * one place a `SchoolState` meets a `THREE.InstancedMesh`.
 */

import type { Carcass } from '@keysrun/shared/sim/chum';

export type SwimAxis = 'x' | 'y';

/** One live fish within a school — legacy's inline `m` member object, typed and renamed. */
export interface FishMember {
  /** Slot index into the species' shared InstancedMesh (legacy `m.idx`). */
  /** Offset from the school centroid, in the school's own heading-relative frame (legacy ox/oz). */
  ox: number;
  oz: number;
  /** Vertical offset within the school's depth band, -1..1 (legacy `oy`). */
  oy: number;
  /**
   * The member's own place in the baked swim cycle, radians — what `render.ts` hands the GPU as
   * `iPhase` and what `hitbox.ts` samples the bend at, so the two cannot disagree.
   *
   * It ADVANCES rather than sitting still. The VAT's cycle runs at one global rate (`uSwimT *
   * angSpeed`), so with a fixed offset every fish of a species beat its tail at exactly the same
   * rate whether it was milling over a patch at 0.75x cruise or bolting at 2.2x. This carries the
   * difference: the extra phase accumulated by swimming faster or slower than cruise. At cruise
   * it accumulates nothing and the look is unchanged.
   */
  swimPhase: number;
  /**
   * The member's FIXED identity offset (what `swimPhase` used to be, and still its starting
   * value). The formation wander, the yaw weave and the ray/turtle roll are all `sin(t * k +
   * seed)` — they want a constant that desyncs this fish from its neighbours, not a clock. Using
   * the advancing `swimPhase` for them would make their frequencies swim with the school's speed.
   */
  seed: number;
  /** Smoothed bank angle, radians — eased toward the school's turn rate so a fish rolls into a
   * corner and back out of it rather than snapping upright the instant the turn ends. */
  bank: number;
  /** Per-member size multiplier (legacy `s`). */
  scale: number;
  /**
   * Where this fish sits in its species' weight range, 0..1 — and the single number both its
   * rendered size and its catchable weight come from.
   *
   * These used to be independent hashes, so the fish you could see was the biggest one and the
   * fish you speared was a different draw entirely: picking a target by eye did nothing. Keeping
   * one value means what looks like the big one IS the big one.
   */
  sizeU: number;
  act: string | null;
  actPhase: number;
  actTimer: number;
  splashed: boolean;
  /** A second within-cycle one-shot guard, alongside `splashed` — used by the whale 'blow' act
   * (school.ts) to fire its "fluke-up on sounding" moment once, later in the same cycle, without
   * re-triggering the earlier "blow" moment's own guard. Unused (stays false) by every other act. */
  splashed2: boolean;
  /** True for the one surfacing cycle (out of a humpback's many) that was rolled a breach instead
   * of a gentle blow — set once when the act starts (school.ts), per the task brief's "if you're
   * feeling ambitious, a rare breach". Unused by every other species/act. */
  breaching: boolean;
  /** Last computed world transform — read by render.ts, and by anything that wants to point a
   * camera or a spear at a specific fish later without re-deriving it. */
  wx: number;
  wy: number;
  wz: number;
  yaw: number;
  pitch: number;
  roll: number;
  worldScale: number;
}

/** A single anchor point a resident/structure-holding school orbits (legacy `g.anchor`). */
export interface SchoolAnchor {
  x: number;
  z: number;
  r: number;
  /**
   * Hold the school at a height above the seabed instead of the species' own water-column band:
   * `h` metres up with `r` of vertical spread. Set only for schools holding on a structure
   * (spawn.ts's wreck layer) - over a 15 m hull in 21 m of water, a 'mid' fish otherwise sits at
   * the 55% line, which is the right height for open reef and exactly wrong for a wreck, where
   * the point is that they are *on the steel*. Bottom-dwellers ignore it (they sit in the scour).
   */
  hold?: { h: number; r: number };
}

export interface SchoolState {
  id: string;
  /** Species key into @keysrun/shared/content/creatures' VIS. */
  type: string;
  cx: number;
  cz: number;
  heading: number;
  /**
   * The centroid's world velocity this step, m/s (`vy` is 0: schools translate horizontally and a
   * member's vertical motion is the bob, which averages out). Written by `stepSchool` where the
   * centroid is advanced, so it is the EXACT translation applied, not an estimate — including the
   * flee multiplier, the anchor's 0.75 and the boundary turn's 0.6.
   *
   * It exists for aim assist's lead (sim/spear.ts). Two estimates were tried in its place and both
   * were worse than no lead at all: species cruise speed along the fish's own facing overshoots,
   * because a member holds a formation offset rather than swimming along its nose, and one-frame
   * differencing of a member's world position returns the swim WIGGLE (a measured, suspiciously
   * constant 1.93 m/s of lateral oscillation) instead of net travel. The school's own translation
   * is neither: it is smooth by construction and is what actually carries the fish through the
   * water, so it needs no low-pass and costs two stores per school per step.
   */
  vx: number; vz: number;
  /**
   * How fast the centroid is turning, rad/s, signed. Written by `stepSchool` from the heading it
   * actually ended the step with. Fish bank into a turn — it is the most obvious thing a real
   * school does that a yaw-only one does not — and this is what `stepMember` rolls them by.
   */
  turnRate: number;
  /** Group-level wander phase (legacy `g.ph`). */
  phase: number;
  /** -1/0/1 sticky boundary-avoidance turn direction (legacy `g.turn`). */
  turn: number;
  flee: number;
  fleeHeading: number;
  /** Smoothed 0..1 bow-riding engagement (dolphin schools only; behavior.ts's `isBowRider`/
   * `bowRideTarget`, school.ts's `stepSchool`) — lerped like `dive` rather than snapping, so a pod
   * eases into and out of riding instead of teleporting onto the bow line the instant a boat gets
   * close enough. Always 0 for every non-dolphin species. */
  bowRide: number;
  /** Flyingfish-style airborne glide timer (legacy `g.glide`). */
  glide: number;
  /**
   * Seconds left in a surface feeding frenzy — the school-wide "bust" (entities/fish/school.ts).
   * A busting species sits deep between frenzies and comes up together for one, rather than each
   * member popping up on its own timer. 0 for every species that does not bust.
   */
  frenzy: number;
  /** Countdown to the next frenzy, seconds. */
  frenzyTimer: number;
  /** Smoothed 0..1 dive-deeper bias (legacy `g.dv`). */
  dive: number;
  diveTimer: number;
  diveTarget: number;
  anchor: SchoolAnchor | null;
  /** Resident schools are deterministic-forever per docs/ARCHITECTURE.md "Resident schools" —
   * never aged out, never swapped for a different roll of the dice. */
  resident: boolean;
  members: FishMember[];
}

/** A moving thing fish may flee from (legacy only ever had the boat; this is deliberately an
 * array so a diver can be added later — see behavior.ts — without changing stepSchool's shape).
 * `'spear'` (game/world.ts's `getSpearTargets`/near-miss detection) is a transient, one-shot-ish
 * entry placed at the exact point a missed shaft passed close to a real fish — "a near-miss
 * should be a real, visible consequence" (task brief). It carries no real speed/heading (a shaft
 * is a near-instant event, not a standing threat), so `nearestTrigger` (behavior.ts) gives it its
 * own dedicated radius instead of reusing the boat's speed-scaled one. */
export interface Threat {
  x: number;
  z: number;
  kind: 'boat' | 'diver' | 'spear';
  /** Absolute speed, m/s — legacy's `Math.abs(boat.speed)` gate (faster boat spooks fish sooner).
   * Meaningless for `kind: 'spear'`; pass 0. */
  speed: number;
  /** World heading, radians, same convention as `sim/boat.ts`'s `state.h`
   * (`fx=-sin(h), fz=-cos(h)` is forward) — optional because only a `kind:'boat'` threat ever
   * carries one, and only once something actually derives it (index.ts reconstructs it from the
   * boat's own frame-to-frame displacement, since the boat sim's `Threat` doesn't otherwise expose
   * heading). Consulted by behavior.ts's `bowRideTarget`; absent/undefined means "don't bow-ride
   * this threat" rather than defaulting to a guessed heading. */
  heading?: number;
}

export interface SchoolCtx {
  t: number;
  dt: number;
  threats: readonly Threat[];
  /**
   * Dead birds floating on the surface — the counterpart to `threats`, and the opposite sign: a
   * `Threat` pushes a school away, a `Carcass` pulls the big, toothy species in (sim/chum.ts's
   * `chumPull`, consulted by `stepSchool`). Owned and stepped by the client
   * (entities/life/carcass.ts); the fish system only reads it.
   *
   * Optional, defaulting to none, so every existing caller and every hand-built test ctx keeps
   * compiling — and because "nothing has been shot" is the normal state of the world.
   */
  carcasses?: readonly Carcass[];
}
