/**
 * Fire / draw / haul bindings for the first-person speargun — mirrors game/fishing/input.ts's
 * binding style (window-level key listeners gated by an `isActive` predicate, touch pads with the
 * same pointer-capture pattern as #touchDiver's other buttons).
 *
 * FIRE is a click/tap on the canvas. With the mouse lock held (the normal case on a desktop —
 * entities/diver/camera.ts) aiming is the mouse itself, so a press cannot also be a turn and the
 * shot goes on the press. Without the lock — touch, or a browser that refused it — the old
 * classifier still applies and the shot is decided on RELEASE. entities/diver/camera.ts binds
 * pointerdown/move/up on the same canvas for drag-to-look, and this file used to fire on
 * `pointerdown`, so every look-drag also loosed a shaft (the "I only turned and a spear
 * appeared" bug). Both bindings now run the same classifier (entities/diver/gesture.ts): a press
 * that stays within LOOK_DRAG_PX of where it started is a tap and fires on pointerup; a press
 * that travels further is a look and never fires, and the look rig applies no rotation while the
 * press is still undecided so a tap does not disturb the aim it is about to shoot along.
 *
 * DRAW is a PRESS of R (or a tap of the touch draw button), not a hold. Reloading is still the
 * player hauling the bands back by hand (sim/spear.ts `stepReload`) rather than a timer, but the
 * haul latches: one press runs it to seated, a second press lets go. Only the key-down edge is
 * forwarded; `index.ts` owns the latch, because it is the side that knows when the gun is loaded.
 *
 * HAUL reuses the diver's own swim-backward key (S/ArrowDown), exactly the way game/fishing's rod
 * reuses `boatInput.back` as "reel" — holding the same key both nudges the diver backward
 * (harmless, the fish is right in front of them) and hauls the line in.
 */
import type { Speargun, DiverAimInput } from './index.js';
import { beginGesture, moveGesture, isTap, type Gesture } from '../diver/gesture.js';
import { diverMouseLocked } from '../diver/camera.js';

export function bindSpeargunInput(
  canvas: HTMLCanvasElement,
  gun: Speargun,
  getAim: () => DiverAimInput,
  isActive: () => boolean,
): () => void {
  let g: Gesture | null = null;
  const onPointerDown = (e: PointerEvent): void => {
    if (!isActive() || e.button !== 0 || g) return;
    // Under the mouse lock there is nothing to disambiguate: aiming is the mouse, so a press is
    // a shot and can be taken on the press rather than held back until release to see whether it
    // turns into a drag. The gesture path below is still the answer for touch, and for a mouse
    // whose lock was refused — see entities/diver/camera.ts.
    if (diverMouseLocked(canvas)) { gun.tryFire(getAim()); return; }
    g = beginGesture(e.pointerId, e.clientX, e.clientY);
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (g && e.pointerId === g.id) moveGesture(g, e.clientX, e.clientY);
  };
  const onPointerUp = (e: PointerEvent): void => {
    if (!g || e.pointerId !== g.id) return;
    const wasTap = isTap(g);
    g = null;
    if (wasTap && isActive()) gun.tryFire(getAim());
  };
  const onPointerCancel = (e: PointerEvent): void => {
    if (g && e.pointerId === g.id) g = null;
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!isActive()) return;
    if (e.code === 'KeyS' || e.code === 'ArrowDown') gun.setHauling(true);
    else if (e.code === 'KeyR' && !e.repeat) gun.toggleDraw();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'KeyS' || e.code === 'ArrowDown') gun.setHauling(false);
    // No `setDrawing(false)` on the R release: the haul is latched, not held.
  };
  // Blur drops the HAUL (that key is held) but not the draw: the draw is latched, and cancelling
  // it on a lost focus would make an alt-tab mid-reload cost you the bands back to the last notch.
  const onBlur = (): void => { gun.setHauling(false); g = null; };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  const tdFire = document.getElementById('tdFire');
  const tdHaul = document.getElementById('tdHaul');
  const tdDraw = document.getElementById('tdDraw');
  // The dedicated fire button has no look gesture to disambiguate from, so it fires on press.
  const onFireTap = (e: PointerEvent): void => {
    if (!isActive()) return;
    e.preventDefault(); e.stopPropagation();
    gun.tryFire(getAim());
  };
  const onHaulDown = (e: PointerEvent): void => {
    if (!isActive()) return;
    e.preventDefault(); e.stopPropagation();
    tdHaul?.setPointerCapture(e.pointerId);
    tdHaul?.classList.add('on');
    gun.setHauling(true);
  };
  const onHaulUp = (): void => { tdHaul?.classList.remove('on'); gun.setHauling(false); };
  const onDrawDown = (e: PointerEvent): void => {
    if (!isActive()) return;
    e.preventDefault(); e.stopPropagation();
    tdDraw?.setPointerCapture(e.pointerId);
    tdDraw?.classList.add('on');
    gun.toggleDraw();
  };
  // Releasing the button does not let go of the bands — the haul is latched (see this file's
  // header). The button's `on` class tracks the finger, so `index.ts` owning the latch means the
  // two can disagree for a frame; that is cosmetic and better than a touch player having to hold
  // a button down through a four-second haul while also swimming.
  const onDrawUp = (): void => { tdDraw?.classList.remove('on'); };
  tdFire?.addEventListener('pointerdown', onFireTap);
  tdHaul?.addEventListener('pointerdown', onHaulDown);
  tdHaul?.addEventListener('pointerup', onHaulUp);
  tdHaul?.addEventListener('pointercancel', onHaulUp);
  tdHaul?.addEventListener('lostpointercapture', onHaulUp);
  tdDraw?.addEventListener('pointerdown', onDrawDown);
  tdDraw?.addEventListener('pointerup', onDrawUp);
  tdDraw?.addEventListener('pointercancel', onDrawUp);
  tdDraw?.addEventListener('lostpointercapture', onDrawUp);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    tdFire?.removeEventListener('pointerdown', onFireTap);
    tdHaul?.removeEventListener('pointerdown', onHaulDown);
    tdHaul?.removeEventListener('pointerup', onHaulUp);
    tdHaul?.removeEventListener('pointercancel', onHaulUp);
    tdHaul?.removeEventListener('lostpointercapture', onHaulUp);
    tdDraw?.removeEventListener('pointerdown', onDrawDown);
    tdDraw?.removeEventListener('pointerup', onDrawUp);
    tdDraw?.removeEventListener('pointercancel', onDrawUp);
    tdDraw?.removeEventListener('lostpointercapture', onDrawUp);
    gun.setHauling(false);
    gun.setDrawing(false);
  };
}
