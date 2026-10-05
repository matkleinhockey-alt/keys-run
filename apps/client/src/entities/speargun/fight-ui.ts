/**
 * Drives the SAME fight-meter DOM the rod fight uses (#fight/#fLabel/#fSub/#fT/#fLine/#fStam —
 * see game/fishing/update.ts's `update()`, which writes these exact ids for a hooked fish) — the
 * task brief is explicit: "use the same fishing meter to reel the fish in", not a second one.
 *
 * Kept in entities/speargun/** (this task's own scope) rather than reaching into game/fishing/**:
 * the DOM ids are shared UI, not fishing-module-private state, and this file only ever writes to
 * them while a speared fish is actually on the line (`index.ts`'s `speared` is non-null) — the
 * rod's own update() and this module are mutually exclusive in practice (you can't be hooked on a
 * rod while swimming as a diver; fishing.update is suspended underwater, see game/fishing/input.ts's
 * `isSuspended`), so there's no real contention over who's currently writing these nodes.
 *
 * One cosmetic difference from the rod: there's no drag dial on a spear (no reel, no drag star),
 * so the drag row (#fDragRow) is hidden for the duration via the `spear-mode` class this adds to
 * #fight (see style.css's `#fight.spear-mode #fDragRow`).
 */
import type { SpearFightState } from '@keysrun/shared/sim/spear';

function $(id: string): HTMLElement | null { return document.getElementById(id); }

export interface SpearFightUI {
  /** Shows the panel with a size-appropriate opening line (index.ts picks the label the same way
   * game/fishing/update.ts's `setHook` does for a hooked fish). */
  show(label: string): void;
  /** `breathFrac` (0..1 of AIR_MAX) swaps the sub-line to an air warning once it's low — the
   * "surfacing mid-fight should resolve sensibly" half of the brief: the meter itself is the
   * place that tells the diver they're now juggling two clocks. */
  update(fight: SpearFightState, breathFrac: number): void;
  hide(): void;
}

export function createSpearFightUI(): SpearFightUI {
  function show(label: string): void {
    $('fight')?.classList.remove('hidden');
    $('fight')?.classList.add('spear-mode');
    const lbl = $('fLabel'); if (lbl) lbl.textContent = label;
    const sub = $('fSub'); if (sub) sub.textContent = 'Hold ▼ to haul it in — ease off if the bar runs red.';
  }

  function update(fight: SpearFightState, breathFrac: number): void {
    const fT = $('fT');
    if (fT) {
      fT.style.width = Math.max(0, Math.min(1, fight.tension)) * 100 + '%';
      fT.className = fight.tension > 0.82 ? 'hot' : fight.tension < 0.08 ? 'slack' : '';
    }
    const fLine = $('fLine');
    if (fLine) fLine.textContent = Math.round(fight.dist) + ' m';
    const fStam = $('fStam');
    if (fStam) fStam.style.width = Math.max(0, Math.min(1, fight.stam)) * 100 + '%';

    const sub = $('fSub');
    if (sub) {
      if (breathFrac < 0.15) sub.textContent = 'Air critical — surface now, even mid-fight.';
      else if (breathFrac < 0.3) sub.textContent = 'Air low — think about surfacing with it on.';
    }
  }

  function hide(): void {
    $('fight')?.classList.add('hidden');
    $('fight')?.classList.remove('spear-mode');
  }

  return { show, update, hide };
}
