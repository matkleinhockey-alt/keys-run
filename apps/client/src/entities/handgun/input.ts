/**
 * Pistol input: fire, reload, aim, draw/holster.
 *
 * ## Why most of this is a window-level CAPTURE listener
 *
 * This game's boat-era controls are global `window` keydown listeners that know nothing about
 * modes: Space casts the rod (game/fishing/input.ts), R starts a buoy race (game/world.ts) or
 * reels in, J goes overboard (game/world.ts), F ties up at a dock (entities/land), V flips the
 * fishing view, E weighs in. Drawing a pistol must make every one of those inert, and "make it
 * inert" has been the source of this project's mode bugs twice (a rod cast firing mid-dive; a race
 * starting from the dive key). The fix that cannot be forgotten by the next feature is to stand in
 * FRONT of them: a capture-phase listener on `window` runs before any bubble-phase window listener
 * and `stopImmediatePropagation()` removes the event from them entirely. So no other module needs
 * to be edited to be pistol-aware, and a new boat-era key added next month is covered too as long
 * as it is listed in `SWALLOW` below.
 *
 * ## The toggle key is 9 (Digit9 / Numpad9)
 *
 * Audited free before it was wired - grep for Digit9/Numpad9 and `'9'` across apps/client/src finds
 * nothing but this file. For the record, what the neighbours own: boat/input.ts has the driving keys,
 * O/U/I/L/T/H/M/C, Digit1/Numpad1 (camera view) and the brackets; game/world.ts has R (race, guarded
 * on rod state, the dive state and land mode), J (dive), F (ashore), B (board), G (quality) and Tab
 * (gear); the diver and speargun own R again underwater, and land owns the walking set. R (reload) is
 * only taken while the pistol is out, by a CAPTURE listener, so the old "R is both reel-in and
 * race" double-binding cannot recur: the capture listener consumes the event before either of those
 * sees it. A handler that stacks onto an existing one (the sunset-button double toggle) is not
 * possible here either, because the pistol button's only listener is added once in createHandgunSystem.
 *
 * The toggle does nothing while the start screen or ANY full-screen panel is open (`suspended`), and
 * `refuse` (game/world.ts) additionally keeps it from drawing while diving, ashore, with a fish on
 * the line, with a catch card up, or mid-race.
 *
 * Key UPS are deliberately NOT swallowed. A Space pressed before drawing and released after must
 * still reach the fishing listener, or its `actionInput.held` stays true forever (found by
 * reading game/fishing/input.ts: keyup is what clears it). A stray keyup is harmless there -
 * `onActionUp` only acts if a cast is charging, and drawing reels the line in first.
 *
 * ## Fire is a TAP, aim is a DRAG
 * Same classifier as the speargun (entities/diver/gesture.ts): a press that stays under 7 px is a
 * click and fires on release, one that travels further is a look and never fires. Binding fire to
 * pointerdown made every look-drag also fire the speargun once (entities/speargun/input.ts); not
 * repeating that.
 */
import { beginGesture, moveGesture, isTap, type Gesture } from '../diver/gesture.js';

export interface PistolControls {
  isGun(): boolean;
  /** The start/title screen is up, or the game is not running: all keys pass through. */
  suspended(): boolean;
  toggle(): void;
  holster(): void;
  fire(): void;
  reload(): void;
  /** Fire a marine flare. */
  flare(): void;
  /** Drag look, radians. */
  look(dYaw: number, dPitch: number): void;
  /** Held look keys: -1/0/1 each. */
  setKeyLook(yaw: number, pitch: number): void;
}

/** Boat-era keys that must do nothing while a pistol is in hand. Space and Enter are repurposed as
 * fire; everything else is simply swallowed. */
const SWALLOW = new Set([
  'Space', 'Enter', 'KeyR', 'KeyJ', 'KeyF', 'KeyV', 'KeyE', 'KeyQ', 'KeyK', 'KeyT', 'KeyB',
  'KeyZ', 'Digit1', 'Digit2', 'Digit3', 'Numpad1', 'Numpad2', 'Numpad3',
]);
const LOOK_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

export const AIM_DRAG_RAD_PER_PX = 0.0035;

export function bindPistolInput(canvas: HTMLCanvasElement, c: PistolControls): () => void {
  let g: Gesture | null = null;
  const held = { l: false, r: false, u: false, d: false };
  const pushKeyLook = (): void => c.setKeyLook((held.l ? 1 : 0) - (held.r ? 1 : 0), (held.u ? 1 : 0) - (held.d ? 1 : 0));

  const onKeyDown = (e: KeyboardEvent): void => {
    if (c.suspended()) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Digit9' || e.code === 'Numpad9') {
      if (!e.repeat) c.toggle();
      e.stopImmediatePropagation(); e.preventDefault();
      return;
    }
    if (!c.isGun()) return;
    if (e.code === 'Escape') { c.holster(); e.stopImmediatePropagation(); return; }
    if (LOOK_KEYS.has(e.code)) {
      if (e.code === 'ArrowLeft') held.l = true; else if (e.code === 'ArrowRight') held.r = true;
      else if (e.code === 'ArrowUp') held.u = true; else held.d = true;
      pushKeyLook();
      e.stopImmediatePropagation(); e.preventDefault();
      return;
    }
    if (!SWALLOW.has(e.code)) return;
    e.stopImmediatePropagation(); e.preventDefault();
    if (e.repeat) return;
    if (e.code === 'Space' || e.code === 'Enter') c.fire();
    else if (e.code === 'KeyR') c.reload();
    else if (e.code === 'KeyZ') c.flare();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (!LOOK_KEYS.has(e.code)) return;
    if (e.code === 'ArrowLeft') held.l = false; else if (e.code === 'ArrowRight') held.r = false;
    else if (e.code === 'ArrowUp') held.u = false; else held.d = false;
    pushKeyLook();
  };
  const onBlur = (): void => { held.l = held.r = held.u = held.d = false; pushKeyLook(); g = null; };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  const onDown = (e: PointerEvent): void => {
    if (!c.isGun() || c.suspended() || e.button !== 0 || g) return;
    g = beginGesture(e.pointerId, e.clientX, e.clientY);
  };
  const onMove = (e: PointerEvent): void => {
    if (!g || e.pointerId !== g.id || !c.isGun()) return;
    const { dx, dy } = moveGesture(g, e.clientX, e.clientY);
    if (dx || dy) c.look(-dx * AIM_DRAG_RAD_PER_PX, -dy * AIM_DRAG_RAD_PER_PX);
  };
  const onUp = (e: PointerEvent): void => {
    if (!g || e.pointerId !== g.id) return;
    const tap = isTap(g);
    g = null;
    if (tap && c.isGun()) c.fire();
  };
  const onCancel = (e: PointerEvent): void => { if (g && e.pointerId === g.id) g = null; };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);

  return () => {
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    held.l = held.r = held.u = held.d = false; pushKeyLook(); g = null;
  };
}
