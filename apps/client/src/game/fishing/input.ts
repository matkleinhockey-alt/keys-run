/**
 * Fishing keyboard/touch input (legacy index.html:4091-4093, 4107, 4109, subset): cast/strike
 * (Space), abort-reel (R), first/third-person fishing view toggle (V). Drag (T while fighting)
 * is wired from game/world.ts instead — see that file's `toggleTrim` callback — because it
 * shares the `T` key with the boat's trim toggle (entities/boat/input.ts), and K/Q (keep fish /
 * open cooler) are wired from game/catch, which owns that behavior.
 */
import type { BoatState } from '@keysrun/shared/sim/boat';
import type { FpState } from '../../entities/camera.js';
import { toast } from '../../ui/toast.js';
import { F } from './state.js';

export interface FishingLogic {
  onAction(boat: BoatState): void;
  onActionUp(boat: BoatState): void;
  reelIn(msg?: string): void;
  actionInput: { held: boolean };
}

export function bindFishingInput(
  logic: FishingLogic,
  fp: FpState,
  getBoat: () => BoatState,
  isSuspended: () => boolean = () => false,
): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    const start = document.getElementById('start');
    if (start && !start.classList.contains('hidden')) return;
    // Suspended while diving (game/world.ts passes `diver.mode === 'diver'`): this module's
    // window-level Space listener has no idea the diver exists, and Space doubles as the diver's
    // ascend key (entities/diver/input.ts) — without this guard, holding Space to surface also
    // charges/fires a rod cast in the background (confirmed: a stray "N m cast into the reef"
    // toast and a visible line/bobber mid-dive). Same root cause as entities/camera.ts's
    // bindCameraPointerControls, which world.ts already works around for look/camera state; this
    // is the fishing-input half of the same "boat-era global listener doesn't know diving exists"
    // class of bug.
    if (isSuspended()) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!e.repeat) { logic.actionInput.held = true; logic.onAction(getBoat()); }
      return;
    }
    if (e.code === 'KeyR' && (F.state === 'waiting' || F.state === 'casting' || F.state === 'nibble')) {
      logic.reelIn('Line reeled in.');
      return;
    }
    if (e.code === 'KeyV') {
      fp.pref = !fp.pref;
      toast(fp.pref ? 'First-person fishing view on.' : 'Third-person fishing view.');
    }
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (isSuspended()) return;
    if (e.code === 'Space') { logic.actionInput.held = false; logic.onActionUp(getBoat()); }
  };
  const onBlur = (): void => { logic.actionInput.held = false; };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  const tAct = document.getElementById('tAct');
  const onDown = (e: PointerEvent): void => { e.preventDefault(); e.stopPropagation(); tAct?.setPointerCapture(e.pointerId); tAct?.classList.add('on'); logic.actionInput.held = true; logic.onAction(getBoat()); };
  const onUp = (): void => { logic.actionInput.held = false; tAct?.classList.remove('on'); logic.onActionUp(getBoat()); };
  tAct?.addEventListener('pointerdown', onDown);
  tAct?.addEventListener('pointerup', onUp);
  tAct?.addEventListener('pointercancel', onUp);
  tAct?.addEventListener('lostpointercapture', onUp);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    tAct?.removeEventListener('pointerdown', onDown);
    tAct?.removeEventListener('pointerup', onUp);
    tAct?.removeEventListener('pointercancel', onUp);
    tAct?.removeEventListener('lostpointercapture', onUp);
  };
}
