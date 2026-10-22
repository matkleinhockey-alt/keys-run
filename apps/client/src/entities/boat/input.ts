/**
 * Keyboard, pointer and touch input for driving the boat and the camera/chart/sea-state/sunset
 * controls that go with it.
 *
 * Ported faithfully from legacy/index.html:4062-4130, trimmed to Phase 0's scope: fishing
 * (cast/strike/reel/drag/cooler/leaderboard), the fishing buddy, music, sound, the Freeman
 * shower, and the Miami run are out of scope (see src/stubs.ts and this project's report) and
 * their key bindings are dropped rather than wired to no-ops users could press and get nothing.
 * Driving, trim, gear, engine, camera view/zoom, sea state, sunset, underwater lights and the
 * chart stay.
 */
import type { BoatInput, BoatState } from '@keysrun/shared/sim/boat';

/**
 * `BoatInput` plus the one thing that is an input but not a key: cruise control.
 *
 * It lives here rather than on the shared `BoatInput` because `stepBoat` has no business knowing
 * about it — to the sim a cruising boat is simply a boat with the throttle held, which is exactly
 * what this produces. Keeping it client-side also means a future server never has to trust a
 * client's claim to be cruising.
 */
export interface BoatInputState extends BoatInput {
  /** Throttle latched on. `fwd` is held true while this is set, whatever the keyboard is doing. */
  cruise: boolean;
}

export function createBoatInput(): BoatInputState {
  return { fwd: false, back: false, left: false, right: false, trimUp: false, trimDn: false, cruise: false };
}

/** A mutable box so input handlers can replace the live `BoatState` for discrete toggles (gear,
 * engine, trim mode) without this module needing to know about `stepBoat`'s call cadence. */
export interface BoatStateBox { state: BoatState }

export interface InputCallbacks {
  toggleTrim(): void;
  shiftGear(): void;
  toggleEngine(): void;
  toggleSunset(): void;
  toggleLights(): void;
  cycleView(): void;
  setSea(delta: number): void;
  zoomChart(k: number): void;
  toggleBigChart(): void;
  resetCamZoom(): void;
  /** Cruise control was switched on or off — for the toast and the HUD light. */
  setCruise(on: boolean): void;
}

const KEYMAP: Record<string, keyof Pick<BoatInput, 'fwd' | 'back' | 'left' | 'right'>> = {
  KeyW: 'fwd', ArrowUp: 'fwd', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
};

export function bindBoatInput(input: BoatInputState, box: BoatStateBox, cb: InputCallbacks): () => void {
  /**
   * Is the throttle key physically down? Tracked separately from `input.fwd`, because `fwd` is
   * the OR of this and the cruise latch and the two have to be able to disagree.
   *
   * Without it, dropping cruise could only ever set `fwd` — and the astern cancel below cleared
   * the latch while leaving `fwd` true, so the boat accelerated to its top speed and stayed
   * there with nothing held and the lamp off. Measured: 33.7 -> 36.5 -> 38.6 m/s after the
   * "brake".
   */
  let fwdHeld = false;
  /** Throttle open = the key is down OR cruise is latched. Everything that touches `fwd` goes
   * through this, so releasing W cannot silently cancel a cruise the player set deliberately,
   * and dropping cruise cannot silently leave the throttle open. */
  const applyThrottle = (): void => { input.fwd = fwdHeld || input.cruise; };
  const onKeyDown = (e: KeyboardEvent) => {
    const start = document.getElementById('start');
    if (start && !start.classList.contains('hidden')) return;
    if (e.code === 'KeyO') { cb.toggleSunset(); return; }
    if (e.code === 'KeyU') { cb.shiftGear(); return; }
    if (e.code === 'KeyI') { cb.toggleEngine(); return; }
    if (e.code === 'KeyL') { cb.toggleLights(); return; }
    if (e.code === 'Digit1' || e.code === 'Numpad1') { cb.cycleView(); return; }
    if (e.code === 'BracketLeft') { cb.zoomChart(0.7); return; }
    if (e.code === 'BracketRight') { cb.zoomChart(1 / 0.7); return; }
    if (e.code === 'KeyT') { cb.toggleTrim(); return; }
    if (e.code === 'Digit6' || e.code === 'Numpad6') {
      input.cruise = !input.cruise;
      applyThrottle();
      cb.setCruise(input.cruise);
      return;
    }
    if (box.state.trimMode && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
      e.preventDefault();
      if (e.code === 'ArrowUp') input.trimUp = true; else input.trimDn = true;
      return;
    }
    if (KEYMAP[e.code]) {
      const k = KEYMAP[e.code];
      // Astern is the brake, the way it is in a car: if you reach for reverse you have stopped
      // wanting to cruise, and leaving it latched would fight you the moment you let go.
      if (k === 'back' && input.cruise) { input.cruise = false; cb.setCruise(false); }
      if (k === 'fwd') fwdHeld = true; else input[k] = true;
      applyThrottle();
      e.preventDefault();
    }
    if (e.code === 'KeyH') cb.setSea(1);
    if (e.code === 'KeyM') cb.toggleBigChart();
    if (e.code === 'KeyC') cb.resetCamZoom();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'ArrowUp') input.trimUp = false;
    if (e.code === 'ArrowDown') input.trimDn = false;
    if (KEYMAP[e.code]) {
      const k = KEYMAP[e.code];
      if (k === 'fwd') fwdHeld = false; else input[k] = false;
      applyThrottle();
    }
  };
  const onBlur = () => {
    input.back = input.left = input.right = input.trimUp = input.trimDn = false;
    // Cruise survives a lost focus. Alt-tabbing is not a reason to come back to a stopped boat,
    // and the physical keys are all released here anyway.
    fwdHeld = false;
    applyThrottle();
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  const touchBindings: Array<[string, keyof Pick<BoatInput, 'fwd' | 'back' | 'left' | 'right'>, 'up' | 'dn' | null]> = [
    ['tL', 'left', null], ['tR', 'right', null], ['tUp', 'fwd', 'up'], ['tDn', 'back', 'dn'],
  ];
  const touchCleanups: Array<() => void> = [];
  for (const [id, key, trimKey] of touchBindings) {
    const el = document.getElementById(id);
    if (!el) continue;
    const down = (e: PointerEvent) => {
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      el.classList.add('on');
      if (trimKey && box.state.trimMode) { if (trimKey === 'up') input.trimUp = true; else input.trimDn = true; }
      else input[key] = true;
    };
    const up = () => {
      if (trimKey) { input.trimUp = false; input.trimDn = false; }
      input[key] = false;
      el.classList.remove('on');
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    touchCleanups.push(() => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
    });
  }
  const tView = document.getElementById('tView');
  const onTView = () => cb.cycleView();
  tView?.addEventListener('click', onTView);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    touchCleanups.forEach((fn) => fn());
    tView?.removeEventListener('click', onTView);
  };
}
