/**
 * Small local seams for the two systems this module does not own and that do not exist yet in
 * this phase: the underwater renderer (surface-crossing muffle) and the diver's breath-hold state
 * (heartbeat cue). Per the task brief: "code against a small local interface and note the
 * integration point" rather than importing real modules from `world/**` or `entities/diver/**`.
 *
 * Everything else this package needs (boat physics state, boat spec) is read from
 * `@keysrun/shared`, which is the actual cross-app seam per docs/ARCHITECTURE.md — not a stand-in.
 */

/**
 * INTEGRATION POINT (underwater agent, `apps/client/src/world/**` or wherever the underwater
 * render pass lands): construct one of these — polling is sufficient, the callback is optional
 * sugar — and pass it into `createUnderwaterAudio(src)` (see `audio/underwater.ts`). The ~200ms
 * y=0 crossing is "the most important moment in the game" per docs/ARCHITECTURE.md; audio starts
 * crossfading the instant `isUnderwater()` flips, so call it every frame rather than caching.
 */
export interface SurfaceTransitionSource {
  /** True while the camera/listener head is currently below the water surface. */
  isUnderwater(): boolean;
  /**
   * Optional push-based variant: subscribe to the exact crossing frame instead of relying on the
   * per-frame poll. Returns an unsubscribe function. `goingUnder` is true diving in, false
   * breaking the surface.
   */
  onCross?(cb: (goingUnder: boolean) => void): () => void;
}

/**
 * INTEGRATION POINT (diver agent, `apps/client/src/entities/diver/**`): the freedive breath-hold
 * model (docs/ARCHITECTURE.md "Freedive physics" — ~90s hold, `ATA = 1 + depth/10` drain rate).
 * Pass an implementation into `createUnderwaterAudio(..., breath)` for the rising heartbeat cue.
 */
export interface BreathSource {
  /** 0 (blacked out) .. 1 (full breath), after ATA-scaled drain. */
  airFraction(): number;
  /** True while actually submerged and holding breath (as opposed to standing on the boat). */
  isHolding(): boolean;
}

/** A remote boat's engine, exactly as much as the audio engine needs to spatialize it. Shared
 * shape for buddy/traffic/racer/multiplayer-ghost engines — all four are "another boat's motor
 * somewhere on the chart" and differ only in distance-gating thresholds and doppler fidelity
 * (see `engine.ts`'s `updateTrafficEngines`/`updateRacerEngines`/`updateBuddyEngine`). */
export interface RemoteEngineSource {
  /** Stable key so the lazily-created `EngineSynth` for this boat persists across frames. */
  id: string;
  x: number;
  z: number;
  /** Signed speed, m/s. */
  speed: number;
  /** Key into `ENGINES` (boat id, or `'gofast'`) — see `engine.ts`. */
  engineProfile: string;
  engineCount: number;
  /** False hides/zeroes the synth without disposing it (legacy racer `g.visible`). */
  audible?: boolean;
  /** Top speed in m/s, for engines (the buddy boat) whose RPM target is a direct fraction of its
   * own top speed rather than a fixed-percentage or sine-wobble target. Defaults to 30 m/s
   * (~58 kn) if omitted. */
  topMs?: number;
}

/** A single hotspot/weedline/rig site worth putting a gull call near — just enough for
 * `AUD.gull`'s "nearest hotspot within earshot" pick (legacy index.html:3214). Satisfied directly
 * by `entities/life/placement.ts`'s `Hotspot`. */
export interface GullSite {
  x: number;
  z: number;
}

/**
 * A moored party boat, as much as the audio engine needs to put a stereo full of muffled music
 * across the water at it — satisfied directly by `entities/life/party-boats.ts`'s `PartyBoat`.
 *
 * Deliberately not a `RemoteEngineSource`: these boats are tied up with the motors off, and what
 * you hear from one is a kick drum, a bass bed and people. See `engine.ts`'s `updateParties` for
 * why that is synthesized rather than played as music — in short, at 150 m over open water the
 * only part of a song that survives is the bottom end, and that is cheap to make convincing.
 */
export interface PartySite {
  /** Stable key, so the lazily-created voice persists across frames. */
  id: string;
  x: number;
  z: number;
  /** Tempo of whatever they have on, BPM. Per-boat (not one global tempo) so two boats rafted
   * together never lock into an unnaturally tight groove. */
  bpm: number;
}

/**
 * The pirates' sloop, as much as the audio engine needs: where it is, whether the crew is singing,
 * and a counter that ticks each time somebody speaks so the engine can answer with a hail without
 * `entities/life/pirates.ts` holding a reference to the audio engine (it is polled, like every
 * other site). Absent entirely while they are away — see `engine.ts`'s `updatePirates`.
 *
 * Deliberately not a `RemoteEngineSource`: a sailboat has no engine, and giving it one to get a
 * sound would make `updateTraffic` synthesize a V8 under a gaff cutter.
 */
export interface PirateSite {
  id: string;
  x: number;
  z: number;
  /** Increments on every spoken line; the engine hails once per change. */
  hail: number;
  /** 0 = the captain (low), 1 = the mate (higher, rougher). */
  voice: 0 | 1;
  /** Crew sing while closing and while hove to; they stop once they are sailing away. */
  singing: boolean;
}
