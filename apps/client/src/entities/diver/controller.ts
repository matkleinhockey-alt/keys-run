/**
 * Diver controller: owns the enter/exit-water handoff (jump off the boat, swim, climb back
 * aboard — including the involuntary "wake on the boat" recovery after a blackout) and ticks
 * the shared `stepDiver` at the fixed rate game/world.ts's accumulator already runs the boat at.
 *
 * Per docs/ARCHITECTURE.md's authority model: "the boat becomes server-authoritative while
 * you're in the water and drifts." The net agent wires the real server authority later; this
 * module builds the clean seam for it now — see `boatInputOverride` below.
 */
import {
  BLACKOUT_WAKE_DELAY, createDiverState, stepDiver,
  type DiverState, type DiverEvent, type DiverInput,
} from '@keysrun/shared/sim/diver';
import type { BoatInput } from '@keysrun/shared/sim/boat';
import { makeDiverEnv } from './physics.js';
import { createDiverButtons, bindDiverInput, type DiverButtons } from './input.js';
import { createDiverCamState, bindDiverPointerControls, cycleDiverView, type DiverCamState } from './camera.js';

export type DiverMode = 'boat' | 'diver';

/** Must be at/near the surface and within this of the boat to climb back aboard. */
const REBOARD_RADIUS = 6;
const REBOARD_SURFACE_DEPTH = 1.5;

/** The BoatInput the boat receives every tick while its driver is over the side: all-neutral, so
 * player input never reaches the boat while diving, but `stepBoat` keeps running (and so keeps
 * drifting under its own wave/current forces — it already applies those at zero throttle) — see
 * this file's header. Swap for the server's drift snapshot later; nothing else needs to change. */
export const NEUTRAL_BOAT_INPUT: BoatInput = { fwd: false, back: false, left: false, right: false, trimUp: false, trimDn: false };

export interface DiverController {
  readonly mode: DiverMode;
  readonly state: DiverState | null;
  readonly cam: DiverCamState;
  readonly canReboard: boolean;
  /** Seconds remaining of the involuntary post-blackout hold, 0 once conscious/back aboard. */
  readonly wakingT: number;
  enterWater(boatX: number, boatZ: number, boatHeading: number): void;
  /** No-ops unless swimming at the surface within REBOARD_RADIUS of the boat. */
  requestReboard(): void;
  /** Unconditional climb-aboard — for edge cases outside the normal swim-back flow (switching
   * boats mid-dive, returning to the marina screen). Normal play should use requestReboard. */
  exitToBoat(): void;
  cycleView(): string;
  /** Advances one fixed physics step. No-op (returns []) while mode === 'boat'. May itself flip
   * mode back to 'boat' (the involuntary post-blackout wake-up) — check `mode` after calling. */
  step(t: number, dt: number, boatX: number, boatZ: number): DiverEvent[];
  dispose(): void;
}

export interface DiverControllerDeps {
  canvas: HTMLCanvasElement;
}

export function createDiverController(deps: DiverControllerDeps): DiverController {
  const buttons: DiverButtons = createDiverButtons();
  const cam: DiverCamState = createDiverCamState();
  let unbindInput: (() => void) | null = null;
  let unbindPointer: (() => void) | null = null;

  let mode: DiverMode = 'boat';
  let state: DiverState | null = null;
  let canReboard = false;
  let wakingT = 0;

  function exitToBoat(): void {
    mode = 'boat';
    state = null;
    canReboard = false;
    wakingT = 0;
    unbindInput?.(); unbindInput = null;
    unbindPointer?.(); unbindPointer = null;
  }

  return {
    get mode() { return mode; },
    get state() { return state; },
    get cam() { return cam; },
    get canReboard() { return canReboard; },
    get wakingT() { return wakingT; },

    enterWater(boatX: number, boatZ: number, boatHeading: number): void {
      if (mode === 'diver') return;
      // Jump off the side: offset perpendicular to the boat's heading so the diver doesn't spawn
      // inside the hull. Same forward/right convention as sim/boat.ts (fx=-sin(h), fz=-cos(h)).
      const rx = Math.cos(boatHeading), rz = -Math.sin(boatHeading);
      const x = boatX + rx * 4, z = boatZ + rz * 4;
      state = createDiverState(x, -0.2, z, boatHeading);
      cam.yaw = boatHeading; cam.pitch = -0.15; cam.mode = 'mask';
      mode = 'diver';
      canReboard = false;
      wakingT = 0;
      unbindInput = bindDiverInput(buttons, () => mode === 'diver');
      unbindPointer = bindDiverPointerControls(deps.canvas, cam, () => mode === 'diver');
    },

    requestReboard(): void {
      if (mode === 'diver' && canReboard && state && !state.blackedOut) exitToBoat();
    },

    exitToBoat(): void { exitToBoat(); },

    cycleView(): string { return cycleDiverView(cam); },

    step(t: number, dt: number, boatX: number, boatZ: number): DiverEvent[] {
      if (mode !== 'diver' || !state) return [];

      if (state.blackedOut) {
        wakingT += dt;
        const input: DiverInput = { fwd: false, back: false, left: false, right: false, ascend: false, descend: false, sprint: false, lookYaw: cam.yaw, lookPitch: cam.pitch };
        state = stepDiver(state, input, makeDiverEnv(t), dt);
        if (wakingT >= BLACKOUT_WAKE_DELAY) {
          const events = state.events;
          exitToBoat();
          return events;
        }
        return state.events;
      }

      const input: DiverInput = {
        fwd: buttons.fwd, back: buttons.back, left: buttons.left, right: buttons.right,
        ascend: buttons.ascend, descend: buttons.descend, sprint: buttons.sprint,
        lookYaw: cam.yaw, lookPitch: cam.pitch,
      };
      state = stepDiver(state, input, makeDiverEnv(t), dt);

      const depth = Math.max(0, -state.y);
      const dx = state.x - boatX, dz = state.z - boatZ;
      canReboard = depth < REBOARD_SURFACE_DEPTH && Math.hypot(dx, dz) < REBOARD_RADIUS;

      return state.events;
    },

    dispose(): void {
      unbindInput?.();
      unbindPointer?.();
    },
  };
}
