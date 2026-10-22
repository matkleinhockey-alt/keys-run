/**
 * Fire / draw / haul bindings for the first-person speargun — mirrors game/fishing/input.ts's
 * binding style (window-level key listeners gated by an `isActive` predicate, touch pads with the
 * same pointer-capture pattern as #touchDiver's other buttons).
 *
 * FIRE is a clean click/tap on the canvas, decided on RELEASE. entities/diver/camera.ts binds
 * pointerdown/move/up on the same canvas for drag-to-look, and this file used to fire on
 * `pointerdown`, so every look-drag also loosed a shaft (the "I only turned and a spear
 * appeared" bug). Both bindings now run the same classifier (entities/diver/gesture.ts): a press
 * that stays within LOOK_DRAG_PX of where it started is a tap and fires on pointerup; a press
 * that travels further is a look and never fires, and the look rig applies no rotation while the
 * press is still undecided so a tap does not disturb the aim it is about to shoot along.
 *
 * DRAW is hold-R (or the touch draw button): reloading is the player hauling the bands back by
 * hand (sim/spear.ts `stepReload`), not a timer, so it needs an input that stays held.
 *
 * HAUL reuses the diver's own swim-backward key (S/ArrowDown), exactly the way game/fishing's rod
 * reuses `boatInput.back` as "reel" — holding the same key both nudges the diver backward
 * (harmless, the fish is right in front of them) and hauls the line in.
 */
import type { Speargun, DiverAimInput } from './index.js';
import { beginGesture, moveGesture, isTap, type Gesture } from '../diver/gesture.js';

export function bindSpeargunInput(
  canvas: HTMLCanvasElement,
  gun: Speargun,
  getAim: () => DiverAimInput,
  isActive: () => boolean,
): () => void {
  let g: Gesture | null = null;
  const onPointerDown = (e: PointerEvent): void => {
    if (!isActive() || e.button !== 0 || g) return;
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
    else if (e.code === 'KeyR' && !e.repeat) gun.setDrawing(true);
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'KeyS' || e.code === 'ArrowDown') gun.setHauling(false);
    else if (e.code === 'KeyR') gun.setDrawing(false);
  };
  const onBlur = (): void => { gun.setHauling(false); gun.setDrawing(false); g = null; };
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
    gun.setDrawing(true);
  };
  const onDrawUp = (): void => { tdDraw?.classList.remove('on'); gun.setDrawing(false); };
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
