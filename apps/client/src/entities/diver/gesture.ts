/**
 * One canvas press, two possible meanings: a LOOK drag (turn the head/swim heading) or a TAP
 * (fire the speargun). Both used to bind `pointerdown` on the same canvas and both reacted to it
 * immediately, so every look-drag also fired the gun — the player saw a shaft leave the muzzle
 * when all they did was turn. Nothing about the press itself says which it is until the pointer
 * either moves or lifts, so neither consumer may act on `pointerdown`; they must both ask the
 * same classifier, which is this file.
 *
 * Rules (measured against pointer displacement from the press point, NOT accumulated path
 * length: a trackpad finger or a held mouse jitters a pixel or two every event, and summing that
 * turns a perfectly still tap into a "drag" after a few hundred ms):
 *
 *  - Displacement stays under LOOK_DRAG_PX for the whole press -> it is a tap; it fires on
 *    release. The look rig applies no rotation at all while a press is still undecided, so a tap
 *    never nudges the aim it is about to shoot along.
 *  - Displacement crosses LOOK_DRAG_PX at any point -> it is a look, permanently for this press
 *    (dragging back to the start does not turn it into a tap). The look rig then applies the full
 *    displacement so far, so the dead zone costs no rotation.
 *
 * 7 px (CSS pixels, so DPR independent): a mouse click moves 0-2 px, a finger tap 3-6 px; the
 * slowest deliberate look drag crosses 7 px in well under 100 ms. Pure and clock-free so it can be
 * unit tested without a DOM.
 */
export const LOOK_DRAG_PX = 7;

export type GestureKind = 'undecided' | 'look';

export interface Gesture {
  id: number;
  x0: number;
  y0: number;
  /** Last point processed — the look rig differences against this. */
  lx: number;
  ly: number;
  kind: GestureKind;
}

export function beginGesture(id: number, x: number, y: number): Gesture {
  return { id, x0: x, y0: y, lx: x, ly: y, kind: 'undecided' };
}

/**
 * Feeds a pointer move into the gesture. Returns the look delta (px) the caller should apply this
 * event: zero while undecided, the whole displacement since the press on the event that crosses
 * the threshold, then the ordinary incremental delta.
 */
export function moveGesture(g: Gesture, x: number, y: number): { dx: number; dy: number } {
  if (g.kind === 'undecided') {
    if (Math.hypot(x - g.x0, y - g.y0) < LOOK_DRAG_PX) return { dx: 0, dy: 0 };
    g.kind = 'look';
    g.lx = g.x0; g.ly = g.y0;
  }
  const dx = x - g.lx, dy = y - g.ly;
  g.lx = x; g.ly = y;
  return { dx, dy };
}

/** True when releasing now should count as a click/tap (the press never became a look). */
export const isTap = (g: Gesture): boolean => g.kind === 'undecided';
