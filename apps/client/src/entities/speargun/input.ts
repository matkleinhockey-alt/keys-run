/**
 * Fire/haul bindings for the first-person speargun — mirrors game/fishing/input.ts's binding
 * style exactly (window-level key listeners gated by an `isActive` predicate, a touch pad with
 * the same pointer-capture pattern as #touchDiver's other buttons).
 *
 * Fire is the left mouse button / primary touch tap: entities/diver/camera.ts already binds
 * pointerdown/move/up on the same canvas for drag-to-look (`bindDiverPointerControls`), so a
 * plain click-without-dragging both "aims" (it's already pointed wherever the drag last left it)
 * and fires — the same click+mouselook coexistence any FPS uses. Haul reuses the diver's own
 * swim-backward key (S/ArrowDown), exactly the way game/fishing's rod reuses `boatInput.back` as
 * "reel" (see update.ts's `const reel = deps.boatInput.back || ...`) — holding the same key both
 * nudges the diver backward (harmless, the fish is right in front of them) and hauls the line in.
 */
import type { Speargun, DiverAimInput } from './index.js';

export function bindSpeargunInput(
  canvas: HTMLCanvasElement,
  gun: Speargun,
  getAim: () => DiverAimInput,
  isActive: () => boolean,
): () => void {
  const onPointerDown = (e: PointerEvent): void => {
    if (!isActive() || e.button !== 0) return;
    gun.tryFire(getAim());
  };
  canvas.addEventListener('pointerdown', onPointerDown);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (!isActive()) return;
    if (e.code === 'KeyS' || e.code === 'ArrowDown') gun.setHauling(true);
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'KeyS' || e.code === 'ArrowDown') gun.setHauling(false);
  };
  const onBlur = (): void => gun.setHauling(false);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  const tdFire = document.getElementById('tdFire');
  const tdHaul = document.getElementById('tdHaul');
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
  tdFire?.addEventListener('pointerdown', onFireTap);
  tdHaul?.addEventListener('pointerdown', onHaulDown);
  tdHaul?.addEventListener('pointerup', onHaulUp);
  tdHaul?.addEventListener('pointercancel', onHaulUp);
  tdHaul?.addEventListener('lostpointercapture', onHaulUp);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    tdFire?.removeEventListener('pointerdown', onFireTap);
    tdHaul?.removeEventListener('pointerdown', onHaulDown);
    tdHaul?.removeEventListener('pointerup', onHaulUp);
    tdHaul?.removeEventListener('pointercancel', onHaulUp);
    tdHaul?.removeEventListener('lostpointercapture', onHaulUp);
    gun.setHauling(false);
  };
}
