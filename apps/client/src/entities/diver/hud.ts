/**
 * Diver HUD: breath meter, depth, an ascent warning that escalates from "start heading up" to
 * "SURFACE NOW", and the blackout tunnel-vision/fade overlay. Doc: "Make running out of air feel
 * frightening" — the meter reddens, the warning gets louder, and the vignette closes in well
 * before air actually hits zero, so the scary part is the anticipation, not just the blackout cut.
 */
import { AIR_MAX, SHALLOW_BLACKOUT_DEPTH, type DiverState } from '@keysrun/shared/sim/diver';

function $(id: string): HTMLElement | null { return document.getElementById(id); }

export interface DiverHudCtx {
  canReboard: boolean;
}

export function showDiverHud(show: boolean): void {
  $('diverHud')?.classList.toggle('hidden', !show);
}

/** Assumed comfortable ascent rate (m/s) for the "can I make the surface on this air" estimate
 * below — not the diver's actual vy (which varies with input), just a HUD planning heuristic. */
const ASSUMED_ASCENT_SPEED = 1.2;

export function updateDiverHud(state: DiverState, ctx: DiverHudCtx): void {
  const depth = Math.max(0, -state.y);
  const airFrac = Math.max(0, Math.min(1, state.air / AIR_MAX));

  const fill = $('breathFill');
  if (fill) fill.style.width = (airFrac * 100).toFixed(1) + '%';
  const pct = $('airPct');
  if (pct) pct.textContent = Math.round(airFrac * 100) + '%';
  const bar = $('breathBar');
  bar?.classList.toggle('critical', airFrac < 0.15 && !state.blackedOut);
  bar?.classList.toggle('low', airFrac < 0.3 && airFrac >= 0.15);

  const depthEl = $('diveDepth');
  if (depthEl) depthEl.textContent = depth.toFixed(1) + ' m';

  const ascentTimeNeeded = depth / ASSUMED_ASCENT_SPEED;
  const margin = state.air - ascentTimeNeeded;
  let warn = '';
  if (airFrac < 0.12 || margin < 4) warn = 'SURFACE NOW — air critical';
  else if (depth < SHALLOW_BLACKOUT_DEPTH && airFrac < 0.18) warn = 'Shallow-water blackout risk — ascend gently';
  else if (airFrac < 0.3 && depth > 3) warn = 'Air low — start heading up';
  const warnEl = $('ascentWarn');
  if (warnEl) {
    warnEl.textContent = warn;
    warnEl.classList.toggle('on', warn.length > 0);
    warnEl.classList.toggle('critical', warn.startsWith('SURFACE'));
  }

  const narcEl = $('narcosisNote');
  narcEl?.classList.toggle('on', state.narcosis);

  const reboard = $('reboardHint');
  reboard?.classList.toggle('hidden', !ctx.canReboard);

  // Tunnel-vision vignette: ramps in under 25% air (matching entities/diver/camera.ts's FOV
  // narrowing), goes fully opaque on blackout, and is the thing that actually fades back out
  // once game/world.ts flips mode back to 'boat' and stops calling this function (see the
  // `#blackout` CSS transition in style.css).
  const vignette = $('blackout');
  if (vignette) {
    const tunnel = airFrac < 0.25 ? Math.min(1, (0.25 - airFrac) / 0.25) : 0;
    vignette.style.opacity = state.blackedOut ? '1' : (tunnel * 0.85).toFixed(2);
  }
}

/** Snap the blackout overlay back to transparent — called once on `exitToBoat` (see
 * entities/diver/controller.ts) so a *manual* climb-aboard (never blacked out) doesn't leave a
 * stale vignette opacity sitting on the element from the instant before mode flipped. */
export function clearBlackoutOverlay(): void {
  const vignette = $('blackout');
  if (vignette) vignette.style.opacity = '0';
}
