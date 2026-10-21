/**
 * The reload prompt: a small bar low-centre that says what the player's hands have to do next
 * ("brace" while the gun recovers, "hold R" to haul the bands, a fill for how far they are
 * drawn). Reloading used to be an invisible 2.5 s timer, so nothing on screen told you it was
 * happening or that you could change how long it took; now it is an act, and acts need a
 * read-out. Inline styles on purpose: a one-element overlay that only exists while diving does
 * not warrant a stylesheet rule that every other agent's style.css edits would have to merge
 * around.
 */
import type { ReloadView } from './gun-viewmodel.js';

export interface ReloadHint {
  update(view: ReloadView, recoverLeft: number, suppressed: boolean): void;
  /** The player pulled the trigger on an empty gun — flash the prompt so they learn why. */
  nudge(): void;
  hide(): void;
  dispose(): void;
}

export function createReloadHint(): ReloadHint {
  const root = document.createElement('div');
  root.id = 'reloadHint';
  root.setAttribute('aria-live', 'polite');
  root.style.cssText = 'position:absolute;left:50%;bottom:132px;transform:translateX(-50%);z-index:7;pointer-events:none;'
    + 'display:none;min-width:190px;padding:7px 12px 9px;border-radius:10px;background:rgba(6,24,34,.62);'
    + 'color:#dff4f7;font:600 13px/1.2 system-ui,sans-serif;text-align:center;letter-spacing:.02em;transition:opacity .25s';
  const label = document.createElement('div');
  const track = document.createElement('div');
  track.style.cssText = 'margin-top:6px;height:5px;border-radius:3px;background:rgba(255,255,255,.18);overflow:hidden;position:relative';
  const fill = document.createElement('div');
  fill.style.cssText = 'height:100%;width:0;background:#f2c14e;border-radius:3px';
  track.appendChild(fill);
  root.append(label, track);
  document.body.appendChild(root);

  let flash = 0;
  let shown = false;
  let lastText = '';

  function setShown(v: boolean): void {
    if (v === shown) return;
    shown = v;
    root.style.display = v ? 'block' : 'none';
  }

  function update(view: ReloadView, recoverLeft: number, suppressed: boolean): void {
    if (flash > 0) flash = Math.max(0, flash - 1 / 30);
    if (view.loaded || suppressed) { setShown(false); return; }
    setShown(true);
    let text: string;
    if (recoverLeft > 0) text = 'Bracing the gun…';
    else if (view.drawing) text = view.effort < 0.7 ? 'Hold still — kicking costs you leverage' : 'Hauling the bands…';
    else text = 'Hold R — haul the bands back';
    if (text !== lastText) { label.textContent = text; lastText = text; }
    fill.style.width = (view.draw * 100).toFixed(1) + '%';
    root.style.opacity = flash > 0 ? '1' : '0.86';
    root.style.outline = flash > 0 ? '2px solid #f2c14e' : 'none';
  }

  return {
    update,
    nudge(): void { flash = 0.6; },
    hide(): void { setShown(false); },
    dispose(): void { root.remove(); },
  };
}
