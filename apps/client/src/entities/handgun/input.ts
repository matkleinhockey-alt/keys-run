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
 * ## Aim is MOUSE LOOK; fire is a click
 *
 * Drawing the pistol asks for pointer lock, and while it is held the mouse aims directly — move
 * it and the gun follows, no button down. That is what a gun in a first-person view is expected
 * to do, and it is also the only way to keep aiming when the cursor reaches the edge of the
 * window, which a drag cannot.
 *
 * The click is then free to be the trigger, with no tap/drag classifier in the way. (The
 * classifier is still here for the FALLBACK path below, and the speargun still needs it for a
 * different reason: it shares the canvas with the diver's own drag-look and has no pointer lock
 * of its own, so binding fire to pointerdown there made every look-drag loose a shaft.)
 *
 * Pointer lock can be refused — a browser will deny it without a user gesture, after a recent
 * unlock, or in some embedded contexts. So the old press-and-drag aim is kept as a fallback and
 * chosen per-event by asking whether the pointer is actually locked, rather than by a flag set
 * once at draw time that could be wrong by the time it is read.
 *
 * Escape is the browser's own unlock key and does not reach a keydown handler while locked, so
 * the unlock itself holsters: `pointerlockchange` firing while the gun is still out means the
 * player asked to get out of mouse look, and in this game that is the same thing as putting the
 * gun away.
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
  /** Asked for by `toggle`/`onDown`; the authority is always `document.pointerLockElement`. */
  const locked = (): boolean => document.pointerLockElement === canvas;
  const requestLock = (): void => {
    if (locked()) return;
    // A refusal arrives two different ways and BOTH have to be swallowed, or it takes the caller
    // down with it. The newer API returns a promise that rejects; the call itself can also throw
    // synchronously (measured: `WrongDocumentError: The root document of this element is not
    // valid for pointer lock`). The synchronous throw is the dangerous one — it escaped this
    // function, aborted the rest of `onDown`, and so the fallback gesture was never started:
    // with the lock refused, clicking the canvas did nothing at all and the pistol could not be
    // fired with the mouse. A refusal has to be a non-event; the drag fallback handles it.
    try {
      const r = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (r && typeof r.catch === 'function') r.catch(() => undefined);
    } catch {
      // refused — the fallback path below is the answer
    }
  };
  const releaseLock = (): void => { if (locked()) document.exitPointerLock(); };
  const onLockChange = (): void => {
    // Lost the lock while the gun is still out: that is Escape, or the browser taking it away.
    // Either way the player is no longer in mouse look, so put the gun down rather than leaving
    // them holding it with an aim they cannot move.
    if (!locked() && c.isGun()) c.holster();
  };
  document.addEventListener('pointerlockchange', onLockChange);
  const held = { l: false, r: false, u: false, d: false };
  const pushKeyLook = (): void => c.setKeyLook((held.l ? 1 : 0) - (held.r ? 1 : 0), (held.u ? 1 : 0) - (held.d ? 1 : 0));

  /**
   * The gun can be holstered by something that is not this module — the marina button, going
   * over the side, a race starting (game/world.ts's `handgun.exitToBoat`). None of those know
   * about the pointer lock, and a locked pointer with no gun in hand is the worst state in the
   * game: the cursor is captured and nothing can be clicked. So every input this module sees
   * checks first, which means the state cannot survive past the player's next keystroke or
   * mouse movement.
   */
  const releaseIfHolstered = (): void => { if (!c.isGun() && locked()) releaseLock(); };

  const onKeyDown = (e: KeyboardEvent): void => {
    releaseIfHolstered();
    if (c.suspended()) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Digit9' || e.code === 'Numpad9') {
      if (!e.repeat) {
        c.toggle();
        // Drawing locks the pointer; holstering gives it back. Requested from the keydown itself
        // because that keypress is the user gesture a browser wants to see.
        if (c.isGun()) requestLock(); else releaseLock();
      }
      e.stopImmediatePropagation(); e.preventDefault();
      return;
    }
    if (!c.isGun()) return;
    // Only reached when the pointer is NOT locked — the browser eats Escape to unlock, and
    // `onLockChange` holsters for us in that case.
    if (e.code === 'Escape') { releaseLock(); c.holster(); e.stopImmediatePropagation(); return; }
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
    if (!c.isGun() || c.suspended() || e.button !== 0) return;
    if (locked()) { c.fire(); return; }      // locked: the click is purely the trigger
    // Not locked. The click is the gesture a browser will accept, so spend it on getting the
    // lock rather than on a shot — firing here as well would put a round downrange every time
    // the player clicked to regain mouse look after an alt-tab.
    requestLock();
    if (!g) g = beginGesture(e.pointerId, e.clientX, e.clientY);
  };
  const onMove = (e: PointerEvent): void => {
    if (!c.isGun()) { releaseIfHolstered(); return; }
    if (locked()) {
      // Mouse look. `movementX/Y` is the raw device delta and keeps working with the cursor
      // pinned, which is the whole reason for the lock.
      if (e.movementX || e.movementY) c.look(-e.movementX * AIM_DRAG_RAD_PER_PX, -e.movementY * AIM_DRAG_RAD_PER_PX);
      return;
    }
    if (!g || e.pointerId !== g.id) return;
    const { dx, dy } = moveGesture(g, e.clientX, e.clientY);
    if (dx || dy) c.look(-dx * AIM_DRAG_RAD_PER_PX, -dy * AIM_DRAG_RAD_PER_PX);
  };
  const onUp = (e: PointerEvent): void => {
    if (!g || e.pointerId !== g.id) return;
    const tap = isTap(g);
    g = null;
    // Fallback path only: a tap fires. When locked, `onDown` already did it.
    if (tap && c.isGun() && !locked()) c.fire();
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
    document.removeEventListener('pointerlockchange', onLockChange);
    releaseLock();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    held.l = held.r = held.u = held.d = false; pushKeyLook(); g = null;
  };
}
