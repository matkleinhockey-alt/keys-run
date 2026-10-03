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

export function createBoatInput(): BoatInput {
  return { fwd: false, back: false, left: false, right: false, trimUp: false, trimDn: false };
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
}

const KEYMAP: Record<string, keyof Pick<BoatInput, 'fwd' | 'back' | 'left' | 'right'>> = {
  KeyW: 'fwd', ArrowUp: 'fwd', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
};

export function bindBoatInput(input: BoatInput, box: BoatStateBox, cb: InputCallbacks): () => void {
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
    if (box.state.trimMode && (e.code === 'ArrowUp' || e.code === 'ArrowDown')) {
      e.preventDefault();
      if (e.code === 'ArrowUp') input.trimUp = true; else input.trimDn = true;
      return;
    }
    if (KEYMAP[e.code]) { input[KEYMAP[e.code]] = true; e.preventDefault(); }
    if (e.code === 'KeyH') cb.setSea(1);
    if (e.code === 'KeyM') cb.toggleBigChart();
    if (e.code === 'KeyC') cb.resetCamZoom();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'ArrowUp') input.trimUp = false;
    if (e.code === 'ArrowDown') input.trimDn = false;
    if (KEYMAP[e.code]) input[KEYMAP[e.code]] = false;
  };
  const onBlur = () => {
    input.fwd = input.back = input.left = input.right = input.trimUp = input.trimDn = false;
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
