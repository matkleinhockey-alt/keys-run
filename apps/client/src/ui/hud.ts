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

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** World north is -z and east is +x (the minimap's own frame), so compass bearing = atan2(dx,-dz). */
function bearingDeg(dx: number, dz: number): number { return ((Math.atan2(dx, -dz) * 180 / Math.PI) % 360 + 360) % 360; }
/** 16-point compass word for a world-space offset, e.g. "NNE". */
export function compassWord(dx: number, dz: number): string { return COMPASS_16[Math.round(bearingDeg(dx, dz) / 22.5) % 16]; }

let calloutEl: HTMLElement | null = null;
let calloutText = '';
/** The "birds are working" arrow: points at the nearest live frenzy relative to the bow, with
 * distance. Lazily built (no index.html/CSS churn) and pointer-events:none so it can never eat a
 * click meant for the throttle/cast. `null` hides it. The boat's heading is `-h` as a compass
 * bearing (the gHdg gauge above does exactly that), so the on-screen angle is bearing - heading. */
export function setHotspotCallout(c: { dist: number; dx: number; dz: number; h: number } | null): void {
  if (!c) { if (calloutEl) calloutEl.style.display = 'none'; return; }
  if (!calloutEl) {
    const host = $('hud');
    if (!host) return;
    calloutEl = document.createElement('div');
    calloutEl.id = 'hsCallout';
    calloutEl.style.cssText = 'position:absolute;top:136px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:8px;'
      + 'padding:6px 12px;border-radius:18px;background:rgba(13,59,102,.78);color:#f2c14e;font:700 14px sans-serif;pointer-events:none;z-index:5';
    calloutEl.innerHTML = '<span style="display:inline-block;font-size:20px;line-height:1">▲</span><span></span>';
    host.appendChild(calloutEl);
  }
  calloutEl.style.display = 'flex';
  const rel = bearingDeg(c.dx, c.dz) - (-c.h * 180 / Math.PI);
  (calloutEl.firstElementChild as HTMLElement).style.transform = `rotate(${rel.toFixed(0)}deg)`;
  const txt = 'Birds working · ' + Math.round(c.dist / 10) * 10 + ' m ' + compassWord(c.dx, c.dz);
  if (txt !== calloutText) { calloutText = txt; (calloutEl.lastElementChild as HTMLElement).textContent = txt; }
}
