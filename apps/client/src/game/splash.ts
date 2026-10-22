/**
 * The start screen's beauty shot: the boat lying to in Hawk Channel off the Seven Mile Bridge at
 * golden hour, crew with their hands up, a school working the water under the hull.
 *
 * --- Why this is NOT a second scene ---
 * The obvious reading of "make the load screen a 3D scene" is a second `WebGLRenderer` on its own
 * canvas behind `#start`, built from the same modules. That was rejected, and the reason is the
 * one hard requirement a loading screen has: it must not cost the game anything to start.
 * A second renderer means a second GL context, a second copy of the water plane and of
 * `createBridge()`'s ~1800 m of instanced deck, and a second render pass competing with the real
 * world's for the whole time the player reads the boat cards — all of it thrown away on the first
 * click. And it buys nothing, because **the real world is already rendering behind `#start`**:
 * `main.ts`'s `frame()` calls `world.frame()` from the first animation frame, and `#start` is a
 * translucent overlay, not an opaque one. The game has always drawn its own loading screen; it
 * just drew it badly — a grey-blue veil over whatever happened to be at the spawn dock.
 *
 * So this module adds no geometry, no materials, no render pass and no asset load. It is three
 * numbers and a camera: *where* the boat lies to while `game.running` is false, *where* the eye
 * sits, and *when* the crew put their hands up. Measured cost over the previous start screen:
 * zero extra draw calls, zero extra bytes, zero extra time to first frame (see the project
 * report's timing run).
 *
 * --- Why it animates continuously rather than settling ---
 * It animates because it is free: the waves, the fish, the hull's heave and the crew's mixers are
 * all being stepped by `world.frame()` regardless of whether anything points a camera at them.
 * Settling to a still frame would mean *adding* code to freeze systems that are already running,
 * which is more work for a worse picture. The only genuinely new per-frame work this module does
 * is one `camera.position.set` + `lookAt` and one `cheer()` call every few seconds.
 *
 * --- Where the shot is, and why exactly there ---
 * `SPLASH_X` sits just east of Pigeon Key, so both bridges are in frame (the 1982 US-1 span and
 * the Flagler-era one behind it, `world/bridge/truss.ts`'s steel truss section included) along
 * with the Keys shoreline and its palms behind them. `SPLASH_DZ` is the compromise the water
 * itself forces, and it was found by probing depth at a dozen candidates rather than guessed:
 *   - too close in (≲200 m) and the boat is sitting on the grass flats. `ampFor(depth)` is near
 *     its floor there, so the sea is a mirror with no swell in it at all, and the seabed is a tan
 *     sheet that the fish are hard to pick out against.
 *   - too far out (≳600 m) and the wave envelope is better but `world/water.ts`'s depth-driven
 *     alpha has closed up, and the fish under the hull are simply not visible any more.
 *   - 300 m lands at ~6 m of water: enough swell to see the hull heave on it, still see-through
 *     enough that a passing school reads clearly.
 * Fish are there at all because `entities/fish` populates around the *boat*
 * (`FishWorld.update`'s `focus`), so moving the boat here moves the population here with it —
 * nothing in this module spawns anything.
 */
import * as THREE from 'three';

/**
 * Just east of Pigeon Key (`world/bridge/pigeon-key.ts` puts it at x ≈ -2650) so the key, both
 * bridges and the old bridge's truss are all in the background, and the deck runs away westward
 * into the sunset. Not the humped high span at x ≈ -3140: from there the bridge is a flat line
 * with nothing on it.
 */
export const SPLASH_X = -2480;
/**
 * Metres to the Atlantic side of the island chain (+z). Chosen for the framing, then clamped by
 * `findClearSpot` in `game/world.ts` — this is a wish, not a guarantee, because nothing here
 * knows the local depth or where the bridge piers are.
 */
export const SPLASH_DZ = 300;  // ~6 m of water at SPLASH_X — see the header for how that was picked
/**
 * Index into `@keysrun/shared/waves`'s `SEA_STATES` for the duration of the start screen: 3,
 * "Big swell — big Atlantic rollers". The game's own default is 1 ("Choppy"), and the start
 * screen used to inherit it; on this piece of water it is nearly glassy, because the wave
 * envelope `ampFor(depth)` is tiny inshore (~0.24 at the 6 m here) and Choppy's own scalars do
 * not make up for it. The user asked for a boat floating *in the waves*, and 3 is what actually
 * puts a swell under the hull and gets it heaving and rolling in frame. `game/world.ts` applies
 * it by overriding the derived `sw`/`ch` rather than by writing `seaIdx` — see its call site for
 * why that distinction matters.
 */
export const SPLASH_SEA_IDX = 3;
/**
 * Boat heading, radians. `entities/camera.ts` establishes the convention: a boat at heading `h`
 * points along (-sin h, -cos h), and the eye at azimuth `a` looks along -(sin a, cos a) — so the
 * hull is exactly broadside to the camera when `h = a ± π/2`. This is `framing.azimuth + π/2`
 * backed off by 0.4 rad, which rakes it to a three-quarter bow-on view: the console, the deck and
 * the crew on it, rather than a flat slab of hull side.
 */
export const SPLASH_H = 0.57;

/**
 * The framing, in one place. Mutable (not `const`s inlined into the maths) for exactly one
 * reason: `window.__splashDebug` below. Composing a shot is a dozen rounds of nudge-and-look, and
 * on this project's software-GPU sandbox a round trip through "edit a const, reload, wait for the
 * world to build, wait for the glTF" is about a minute. Through the hook it is a second, and the
 * numbers that ended up here were all found that way rather than guessed.
 *
 *  - `dist`/`height`: eye offset from the boat. ~2x a 10 m hull reads the boat whole with room
 *    for the span behind it. The height is a compromise with a reason on both sides: lower puts
 *    the bridge deck against the sky but flattens the water into a mirror, higher looks down
 *    *through* the surface at the fish (world/water.ts's shallow-water alpha) but loses the sky.
 *  - `azimuth`: where the eye sits, measured the way `entities/camera.ts`'s chase rig measures it
 *    — offset = (sin a, cos a) * dist, so the view direction is -(sin a, cos a). -0.6 puts the eye
 *    southwest of the boat looking northeast: bridge across the background, sun over the camera's
 *    shoulder. The mirror of it (+0.85, looking northwest *into* the sunset) was tried first and
 *    is the more obvious postcard, but it backlights everything — the boat and the crew on it go
 *    to flat black silhouettes, and the two things the user asked to be able to see stop being
 *    visible. Shooting with the sun behind keeps the hull and the deck lit while the sky over the
 *    bridge is still the full sunset gradient.
 *  - `frameYaw`: turns the finished camera to its left, which slides the whole subject to the
 *    *right* of frame. The start card occupies the left half of the screen (style.css's `#start`
 *    rules), so a shot composed on centre is a shot composed behind the text.
 *  - `sweep`: a slow lateral arc instead of `entities/camera.ts`'s full `!gameRunning` orbit. The
 *    orbit was tried here first and rejected: half of every revolution points the camera away
 *    from the bridge, so the thing the screen exists to show is absent for ~20 s at a stretch.
 *    An arc keeps it framed and still parallaxes the span against the hull, which is what sells
 *    the shot as live rather than as wallpaper.
 *  - `bob`: a slow rise and fall so the horizon breathes independently of the hull's own heave.
 *  - `lookUp`/`lookAhead`: aim point relative to the boat — `lookAhead` is signed, positive being
 *    toward the bridge. Together they set how far the camera tilts down, and that tilt is what
 *    decides whether the fish are in the shot at all: aimed level the water is all grazing-angle
 *    reflection and the fish under it are invisible (world/water.ts's Fresnel term takes the
 *    surface alpha to 1 at glancing incidence), aimed steeply down the near water fills the frame
 *    and a school reads clearly, but the bridge and the sky go with it. These two numbers were
 *    settled last, by screenshot, as the tilt that keeps a school visible in the near water
 *    without losing the span across the horizon.
 */
const framing = {
  dist: 26,
  height: 4.8,
  azimuth: -0.6,
  frameYaw: 0.3,
  sweepRad: 0.17,
  sweepPeriodS: 26,
  bobM: 0.5,
  bobPeriodS: 17,
  lookUp: 1,
  lookAhead: -2,
};

/**
 * How the crew celebrate. `crewSystem.cheer(seconds)` *restarts* rather than extends (see
 * `entities/crew-model/dance.ts`'s `startCheer`), and its envelope is `min(1, elapsed/0.22) *
 * min(1, left/0.75)` — so re-arming it part-way through the fall gives arms that punch back up
 * instead of a statue holding a pose. Re-arming at 4.0 s into a 5.0 s cheer lands inside that
 * fall: hands up, held, dipped, up again, about every four seconds. A single very long cheer was
 * tried and looks dead, which is the opposite of what the user asked for.
 */
const CHEER_SPAN_S = 5.0, CHEER_EVERY_S = 4.0;

export interface SplashDeps {
  camera: THREE.PerspectiveCamera;
  /** The sky dome and sun disc, which both ride the camera — see `entities/camera.ts`'s tail. */
  sky: THREE.Object3D;
  sunDisc: THREE.Object3D;
  sunDir: THREE.Vector3;
}

export interface SplashBoat { x: number; y: number; z: number }

export interface SplashScene {
  /** False once the player has left the dock. `game/world.ts` skips everything splash-related then. */
  readonly active: boolean;
  /**
   * Advances the shot and overrides this frame's camera with the beauty-shot framing. Must be
   * called *after* `updateCamera`, for the same reason `world.ts`'s `__fishDebugCamera` hook is:
   * whatever the chase rig computed has to lose. Re-plants the sky dome and sun disc on the new
   * eye position, which `updateCamera` already did for the eye this replaces — skip that and the
   * sky dome is off-centre by tens of metres and its horizon gradient visibly shears.
   *
   * `dt` is REAL frame time, not `world.ts`'s `clamped` simulation step, and not `simTime`. Those
   * are capped at 50 ms so the buoyancy accumulator stays stable, which means that on hardware
   * running below 20 fps they advance slower than the wall clock — on this project's ~3 fps
   * software-GPU sandbox, by about 7x. Everything here is presentation on a screen somebody is
   * sitting and looking at: driven off simulation time, the camera sweep crawls and the crew
   * cheer once a minute instead of once every four seconds. Measured, not assumed — the first
   * version of this did use `clamped`, and an instrumented run over 22 s of start screen logged
   * exactly one cheer where it should have logged six.
   */
  frame(deps: SplashDeps, dt: number, boat: SplashBoat, cheer: (seconds: number) => void): void;
  /** Called once, from the "leave the dock" handler. Idempotent. */
  end(): void;
}

export function createSplashScene(): SplashScene {
  let active = true;
  let clock = 0;
  // Starts due, so the deck is already celebrating on the first frame rather than four seconds in.
  let sinceCheer = CHEER_EVERY_S;
  const eye = new THREE.Vector3(), look = new THREE.Vector3();

  return {
    get active() { return active; },
    frame(deps, dt, boat, cheer) {
      if (!active) return;
      clock += dt;
      sinceCheer += dt;
      if (sinceCheer >= CHEER_EVERY_S) { sinceCheer = 0; cheer(CHEER_SPAN_S); }

      const { camera, sky, sunDisc, sunDir } = deps;
      const f = framing;
      const a = f.azimuth + Math.sin((2 * Math.PI * clock) / f.sweepPeriodS) * f.sweepRad;
      eye.set(
        boat.x + Math.sin(a) * f.dist,
        boat.y + f.height + Math.sin((2 * Math.PI * clock) / f.bobPeriodS) * f.bobM,
        boat.z + Math.cos(a) * f.dist,
      );
      look.set(boat.x, boat.y + f.lookUp, boat.z - f.lookAhead);
      camera.position.copy(eye);
      camera.lookAt(look);
      // After lookAt, not folded into the aim point: a yaw is what "slide the subject across the
      // frame" actually is, and doing it as an offset look target instead would also tilt the
      // horizon as the sweep swings.
      camera.rotateY(f.frameYaw);
      camera.updateMatrixWorld(true);
      sky.position.copy(camera.position);
      sunDisc.position.copy(camera.position).addScaledVector(sunDir, 5000);
      sunDisc.lookAt(camera.position);
    },
    end() { active = false; },
  };
}

// DEV/VERIFICATION HOOK ONLY — `__splashDebug.set({ azimuth: 0.9 })` recomposes the shot live, and
// `.get()` reads back what is currently applied, so a Playwright session can sweep the framing and
// screenshot each candidate without a reload per candidate. Same pattern (and same cost: one
// property assignment at module load) as `game/world.ts`'s `__fishDebugCamera`. Nothing in the
// game ever writes to it.
(globalThis as unknown as { __splashDebug?: unknown }).__splashDebug = {
  get: (): typeof framing => ({ ...framing }),
  set: (patch: Partial<typeof framing>): void => { Object.assign(framing, patch); },
};
