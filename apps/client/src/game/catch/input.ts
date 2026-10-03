/**
 * Keyboard/button bindings for the catch flow (legacy index.html:4083-4126, 4165): K keeps the
 * current catch in the cooler, Space (rod fishing's existing action key, via
 * game/fishing/update.ts's `onActionWhileCaught`) and the card's own "Release" button release
 * it, Q opens the cooler panel (Escape or Q again closes it), and E weighs in at a marina dock.
 * game/fishing/input.ts owns Space/R/V (the rod); this module owns everything catch/cooler-
 * related, per that file's header comment.
 */
import type { BoatState } from '@keysrun/shared/sim/boat';
import type { createCatchFlow } from './catch-flow.js';

export type CatchFlow = ReturnType<typeof createCatchFlow>;

function $(id: string): HTMLElement | null { return document.getElementById(id); }

export function bindCatchInput(flow: CatchFlow, getBoat: () => BoatState): () => void {
  const closeCooler = (): void => { $('coolerPanel')?.classList.add('hidden'); };

  const onKeyDown = (e: KeyboardEvent): void => {
    const start = document.getElementById('start');
    if (start && !start.classList.contains('hidden')) return;
    const coolerPanel = $('coolerPanel');
    if (coolerPanel && !coolerPanel.classList.contains('hidden')) {
      if (e.code === 'Escape' || e.code === 'KeyQ') closeCooler();
      return;
    }
    if (e.code === 'KeyK') { flow.keepFish(); return; }
    if (e.code === 'KeyQ') { flow.openCoolerPanel(); return; }
    if (e.code === 'KeyE') { flow.weighIn(getBoat()); return; }
  };
  window.addEventListener('keydown', onKeyDown);

  const btnKeep = $('btnKeep');
  const btnRelease = $('btnRelease');
  const btnCooler = $('btnCooler');
  const btnCoolerClose = $('btnCoolerClose');
  const tDock = $('tDock');
  const onKeep = (): void => flow.keepFish();
  const onRelease = (): void => flow.releaseFish();
  const onOpenCooler = (): void => flow.openCoolerPanel();
  const onDock = (): void => flow.weighIn(getBoat());
  btnKeep?.addEventListener('click', onKeep);
  btnRelease?.addEventListener('click', onRelease);
  btnCooler?.addEventListener('click', onOpenCooler);
  btnCoolerClose?.addEventListener('click', closeCooler);
  tDock?.addEventListener('click', onDock);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    btnKeep?.removeEventListener('click', onKeep);
    btnRelease?.removeEventListener('click', onRelease);
    btnCooler?.removeEventListener('click', onOpenCooler);
    btnCoolerClose?.removeEventListener('click', closeCooler);
    tDock?.removeEventListener('click', onDock);
  };
}
