/**
 * HUD gauges and the context-sensitive hint line.
 *
 * Ported from legacy/index.html:3742-3780, trimmed to Phase 0 scope: score/fish-count/slam
 * pills, the cooler/sea-state/sound/music/buddy/Miami/leaderboard buttons and every fishing-
 * dependent hint string are dropped (see docs/ARCHITECTURE.md Phase 0 scope and src/stubs.ts).
 * Depth/zone/heading/speed/trim/warn gauges and the boat-driving hint text stay.
 */
import { depthAt, zoneAt, offshoreF, ZONE_DESC } from '@keysrun/shared/world/depth';
import { shoreInfo } from '@keysrun/shared/world/chain';
import { SPEED_SCALE } from '@keysrun/shared/content/boats';
import type { BoatState } from '@keysrun/shared/sim/boat';
import { isTouch } from '../core/scene.js';

function $(id: string): HTMLElement | null { return document.getElementById(id); }

function nearestName(x: number, z: number): string {
  const s = shoreInfo(x, z);
  return (s.d < 120 ? 'off ' : 'toward ') + (s.isl ? s.isl.name : '');
}

export interface HudCtx {
  boatLabel: string;
  draft: number;
  running: boolean;
}

let hudT = 0;
let lastHint = '';
const ACT = isTouch() ? '🎣' : 'Space';
void ACT; // kept for parity with legacy's touch-vs-keyboard action label, unused until fishing lands

export function updateHUD(dt: number, boat: BoatState, ctx: HudCtx): void {
  hudT -= dt;
  if (hudT > 0) return;
  hudT = 0.1;

  const kn = Math.abs(boat.speed) / SPEED_SCALE / 0.5144;
  setText('gSpd', kn.toFixed(0));
  setText('gHdg', String(Math.round((((-boat.h * 180 / Math.PI) % 360) + 360) % 360)).padStart(3, '0') + '°');
  const d = depthAt(boat.x, boat.z);
  setText('gDep', (d * 3.28).toFixed(1) + ' ft');
  const zn = zoneAt(boat.x, boat.z), of = offshoreF(boat.x, boat.z);
  setText('gZone', zn === 'Offshore' && of > 0.5 ? 'Deep blue water' : ZONE_DESC[zn]);
  setText('gNear', nearestName(boat.x, boat.z));
  const gThr = $('gThr'); if (gThr) gThr.style.width = Math.max(0, boat.thr) * 100 + '%';
  const gTrim = $('gTrim'); if (gTrim) gTrim.style.left = boat.trimV * 96 + '%';
  setText('gTrimV', Math.round(boat.trimV * 100) + '%');
  setText('gTrimLbl', boat.trimMode ? 'Trim ▲▼' : 'Trim');
  const trimRow = gTrim?.parentElement?.parentElement;
  trimRow?.classList.toggle('on', boat.trimMode);
  const gGear = $('gGear');
  if (gGear) { gGear.textContent = boat.gear; gGear.className = 'g' + boat.gear; }
  setText('gWarn', d < ctx.draft ? 'Aground — back off to deeper water' : (d < ctx.draft + 0.4 && kn > 5 ? 'Shallow water ahead' : ''));
  setText('gBoat', ctx.boatLabel);

  let h: string;
  if (kn > 3) h = isTouch() ? '▲ ▼ throttle · ◀ ▶ steer · follow the chart' : 'W/S throttle · A/D steer · H changes the sea state';
  else if (boat.trimMode) h = 'Trim mode: ▲ trim up, ▼ trim down · W/S throttle · T to exit';
  else h = 'Hold W to get on the throttle · A/D to steer · 1 switches camera view';
  if (h !== lastHint) { setText('hint', h); lastHint = h; }
}

function setText(id: string, text: string): void {
  const el = $(id);
  if (el) el.textContent = text;
}
