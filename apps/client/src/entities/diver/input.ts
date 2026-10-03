/**
 * Keyboard + touch swim controls. WASD/arrows kick relative to look direction (see
 * entities/diver/camera.ts, which owns yaw/pitch — the same split boat driving uses between
 * input.ts and camera.ts), Space ascends, Ctrl/C descends, Shift sprints. Touch gets its own
 * seven-button pad (`#touchDiver` in index.html), shown only while diving, mirroring the boat's
 * pointer-capture pattern in entities/boat/input.ts exactly.
 */
export interface DiverButtons {
  fwd: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  ascend: boolean;
  descend: boolean;
  sprint: boolean;
}

export function createDiverButtons(): DiverButtons {
  return { fwd: false, back: false, left: false, right: false, ascend: false, descend: false, sprint: false };
}

function resetDiverButtons(b: DiverButtons): void {
  b.fwd = b.back = b.left = b.right = b.ascend = b.descend = b.sprint = false;
}

const KEYMAP: Record<string, keyof Pick<DiverButtons, 'fwd' | 'back' | 'left' | 'right'>> = {
  KeyW: 'fwd', ArrowUp: 'fwd', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
};

/** Binds global key/touch listeners for swim control. `isActive` gates every key handler so
 * holding W from a previous (boat-driving) context never leaks a stray swim kick, and vice
 * versa. Returns an unbind function — call it on `exitToBoat` (see entities/diver/controller.ts),
 * mirroring `bindBoatInput`'s cleanup convention exactly. */
export function bindDiverInput(buttons: DiverButtons, isActive: () => boolean): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (!isActive()) return;
    const dir = KEYMAP[e.code];
    if (dir) { buttons[dir] = true; e.preventDefault(); return; }
    if (e.code === 'Space') { buttons.ascend = true; e.preventDefault(); return; }
    if (e.code === 'KeyC' || e.code === 'ControlLeft' || e.code === 'ControlRight') { buttons.descend = true; return; }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') buttons.sprint = true;
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    const dir = KEYMAP[e.code];
    if (dir) { buttons[dir] = false; return; }
    if (e.code === 'Space') buttons.ascend = false;
    if (e.code === 'KeyC' || e.code === 'ControlLeft' || e.code === 'ControlRight') buttons.descend = false;
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') buttons.sprint = false;
  };
  const onBlur = (): void => resetDiverButtons(buttons);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  const touchBindings: Array<[string, keyof DiverButtons]> = [
    ['tdL', 'left'], ['tdR', 'right'], ['tdUp', 'fwd'], ['tdDn', 'back'],
    ['tdAsc', 'ascend'], ['tdDesc', 'descend'], ['tdSprint', 'sprint'],
  ];
  const touchCleanups: Array<() => void> = [];
  for (const [id, key] of touchBindings) {
    const el = document.getElementById(id);
    if (!el) continue;
    const down = (e: PointerEvent): void => {
      if (!isActive()) return;
      e.preventDefault(); e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      el.classList.add('on');
      buttons[key] = true;
    };
    const up = (): void => { buttons[key] = false; el.classList.remove('on'); };
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

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    touchCleanups.forEach((fn) => fn());
    resetDiverButtons(buttons);
  };
}
