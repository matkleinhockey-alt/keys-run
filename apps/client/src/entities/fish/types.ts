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

export type SwimAxis = 'x' | 'y';

/** One live fish within a school — legacy's inline `m` member object, typed and renamed. */
export interface FishMember {
  /** Slot index into the species' shared InstancedMesh (legacy `m.idx`). */
  slot: number;
  /** Offset from the school centroid, in the school's own heading-relative frame (legacy ox/oz). */
  ox: number;
  oz: number;
  /** Vertical offset within the school's depth band, -1..1 (legacy `oy`). */
  oy: number;
  /** Per-member VAT swim-cycle phase offset, radians (legacy `ph`, reused as the swim phase). */
  swimPhase: number;
  /** Per-member size multiplier (legacy `s`). */
  scale: number;
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
}

export interface SchoolState {
  id: string;
  /** Species key into @keysrun/shared/content/creatures' VIS. */
  type: string;
  cx: number;
  cz: number;
  heading: number;
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
 * array so a diver can be added later — see behavior.ts — without changing stepSchool's shape). */
export interface Threat {
  x: number;
  z: number;
  kind: 'boat' | 'diver';
  /** Absolute speed, m/s — legacy's `Math.abs(boat.speed)` gate (faster boat spooks fish sooner). */
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
}
