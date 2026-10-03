/**
 * `applyDiverVisuals(state, model, events, ctx)`: the three.js/DOM side effects of a diver
 * physics step — position/orientation, fin-kick animation speed, and event -> toast translation.
 * Mirrors entities/boat/visuals.ts's `applyBoatVisuals` split exactly: sim/diver.ts stays pure,
 * this is where it meets three.js and the DOM.
 *
 * Faces -Z at yaw=0 (see model.ts), so `rotation.y = state.yaw` needs no conversion — same
 * convention `applyBoatVisuals` uses for `state.h`.
 */
import type { DiverState, DiverEvent } from '@keysrun/shared/sim/diver';
import type { DiverModel } from './model.js';
import { toast } from '../../ui/toast.js';

export interface DiverVisualsCtx {
  t: number;
}

export function applyDiverVisuals(state: DiverState, model: DiverModel, events: readonly DiverEvent[], ctx: DiverVisualsCtx): void {
  model.group.position.set(state.x, state.y, state.z);
  model.group.rotation.set(0, state.yaw, 0, 'YXZ');
  model.animate(ctx.t, Math.hypot(state.vx, state.vy, state.vz));

  for (const ev of events) {
    if (ev.type === 'blackout') {
      toast(ev.cause === 'shallowWaterBlackout'
        ? 'Shallow-water blackout on the ascent — hauled back aboard unconscious. The gear is safe; the dive is not.'
        : "Blacked out from holding your breath too long — hauled back aboard. You lose the fish and the trip; the gear's safe.");
    }
  }
}
