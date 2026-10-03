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
  keepTimer: number;
  /** Simulation time this school last had a member rendered on-screen-range; schools past
   * `DORMANT_TTL` get recycled. Null while active. See spawn.ts's dormant-list doc comment. */
  dormantSince: number | null;
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
}

export interface SchoolCtx {
  t: number;
  dt: number;
  threats: readonly Threat[];
}
