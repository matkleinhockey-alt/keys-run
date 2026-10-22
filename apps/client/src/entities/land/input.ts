/**
 * Keyboard + touch controls for walking. WASD / up-down arrows move relative to where you look,
 * left-right arrows turn the view, Shift runs. Bound when land mode is entered and unbound when it
 * ends (entities/land/controller.ts), and every handler is also gated on `isActive` — the same
 * discipline as entities/diver/input.ts, for the same reason: holding W from driving the boat must
 * never leak a step into the walker, and holding W ashore must never leak throttle into the boat
 * when you board. (game/world.ts also feeds the boat NEUTRAL input while ashore, belt and braces.)
 *
 * Keys the other modes own are left alone: Space is the rod (suspended ashore), E is the dock
 * weigh-in, J dives. The land verbs are F (interact / tie up), B (back to the boat), V (view).
 */
export interface LandButtons {
  fwd: boolean; back: boolean; left: boolean; right: boolean; sprint: boolean;
  /** -1 / 0 / +1: arrow-key view turn. */
  turn: number;
}

export function createLandButtons(): LandButtons {
  return { fwd: false, back: false, left: false, right: false, sprint: false, turn: 0 };
}

export function resetLandButtons(b: LandButtons): void {
  b.fwd = b.back = b.left = b.right = b.sprint = false; b.turn = 0;
}

const KEYMAP: Record<string, 'fwd' | 'back' | 'left' | 'right'> = {
  KeyW: 'fwd', ArrowUp: 'fwd', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', KeyD: 'right',
};

export interface LandActions {
  interact(): void;
  board(): void;
  view(): void;
  close(): void;
}

export function bindLandInput(buttons: LandButtons, actions: LandActions, isActive: () => boolean): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!isActive()) return;
    const dir = KEYMAP[e.code];
    if (dir) { buttons[dir] = true; e.preventDefault(); return; }
    if (e.code === 'ArrowLeft') { buttons.turn = -1; e.preventDefault(); return; }
    if (e.code === 'ArrowRight') { buttons.turn = 1; e.preventDefault(); return; }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') { buttons.sprint = true; return; }
    if (e.repeat) return;
    if (e.code === 'KeyF') actions.interact();
    else if (e.code === 'KeyB') actions.board();
    else if (e.code === 'KeyV') actions.view();
    else if (e.code === 'Escape') actions.close();
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    const dir = KEYMAP[e.code];
    if (dir) buttons[dir] = false;
    if (e.code === 'ArrowLeft' && buttons.turn < 0) buttons.turn = 0;
    if (e.code === 'ArrowRight' && buttons.turn > 0) buttons.turn = 0;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') buttons.sprint = false;
  };
  const onBlur = (): void => resetLandButtons(buttons);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  const pads: Array<[string, () => void, () => void]> = [
    ['tlL', () => { buttons.left = true; }, () => { buttons.left = false; }],
    ['tlR', () => { buttons.right = true; }, () => { buttons.right = false; }],
    ['tlUp', () => { buttons.fwd = true; }, () => { buttons.fwd = false; }],
    ['tlDn', () => { buttons.back = true; }, () => { buttons.back = false; }],
    ['tlRun', () => { buttons.sprint = true; }, () => { buttons.sprint = false; }],
  ];
  const taps: Array<[string, () => void]> = [['tlAct', actions.interact], ['tlBoat', actions.board]];
  const cleanups: Array<() => void> = [];
  for (const [id, down, up] of pads) {
    const el = document.getElementById(id);
    if (!el) continue;
    const d = (e: PointerEvent): void => { if (!isActive()) return; e.preventDefault(); e.stopPropagation(); el.setPointerCapture(e.pointerId); el.classList.add('on'); down(); };
    const u = (): void => { up(); el.classList.remove('on'); };
    el.addEventListener('pointerdown', d); el.addEventListener('pointerup', u); el.addEventListener('pointercancel', u); el.addEventListener('lostpointercapture', u);
    cleanups.push(() => { el.removeEventListener('pointerdown', d); el.removeEventListener('pointerup', u); el.removeEventListener('pointercancel', u); el.removeEventListener('lostpointercapture', u); });
  }
  for (const [id, fn] of taps) {
    const el = document.getElementById(id);
    if (!el) continue;
    const d = (e: PointerEvent): void => { if (!isActive()) return; e.preventDefault(); e.stopPropagation(); fn(); };
    el.addEventListener('pointerdown', d);
    cleanups.push(() => el.removeEventListener('pointerdown', d));
  }

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    cleanups.forEach((fn) => fn());
    resetLandButtons(buttons);
  };
}
