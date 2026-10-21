import { describe, expect, it } from 'vitest';
import { beginGesture, moveGesture, isTap, LOOK_DRAG_PX } from '../src/entities/diver/gesture.js';

describe('look-drag vs fire-tap gesture classifier', () => {
  it('a still click is a tap and never rotates the view', () => {
    const g = beginGesture(1, 400, 300);
    expect(moveGesture(g, 401, 300)).toEqual({ dx: 0, dy: 0 });
    expect(moveGesture(g, 400, 302)).toEqual({ dx: 0, dy: 0 });
    expect(isTap(g)).toBe(true);
  });

  it('jitter does not accumulate into a drag (displacement, not path length)', () => {
    const g = beginGesture(1, 0, 0);
    for (let i = 0; i < 500; i++) moveGesture(g, i % 2 ? 2 : -2, 0);
    expect(isTap(g)).toBe(true);
  });

  it('a drag past the threshold is a look, and is never a tap again', () => {
    const g = beginGesture(1, 100, 100);
    moveGesture(g, 100 + LOOK_DRAG_PX + 1, 100);
    expect(isTap(g)).toBe(false);
    moveGesture(g, 100, 100); // dragging back to the start does not undo it
    expect(isTap(g)).toBe(false);
  });

  it('the look applies the whole displacement so the dead zone costs no rotation', () => {
    const g = beginGesture(1, 0, 0);
    expect(moveGesture(g, 5, 0)).toEqual({ dx: 0, dy: 0 });
    const first = moveGesture(g, 12, 3);
    expect(first).toEqual({ dx: 12, dy: 3 });
    expect(moveGesture(g, 15, 3)).toEqual({ dx: 3, dy: 0 });
  });
});
