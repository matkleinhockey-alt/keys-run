/**
 * The helm: the instrument cluster and the context-sensitive hint line.
 *
 * Originally ported from legacy/index.html:3742-3780 as a readout — speed in big type, two
 * label/value rows, a trim slider. That is a telemetry panel, not a dashboard. The numbers now
 * drive three real round instruments (ui/gauges.ts): a tachometer, a speedometer scaled to the
 * hull you are in, and a short-sweep trim gauge, with the digits kept underneath them the way a
 * helm has an LCD under the dials.
 *
 * The revs come from @keysrun/shared/sim/tach — the same model that drives the engine synth, so
 * the needle and the engine note agree. See the `rpm` declaration for why this steps its own
 * copy instead of reading the audio engine's.
 */
import { depthAt, zoneAt, offshoreF, ZONE_DESC } from '@keysrun/shared/world/depth';
import { shoreInfo } from '@keysrun/shared/world/chain';
import { SPEED_SCALE } from '@keysrun/shared/content/boats';
import type { BoatState } from '@keysrun/shared/sim/boat';
import { isTouch } from '../core/scene.js';
import { createDash, type Dash } from './gauges.js';
import { rpmTarget, stepRpm, IDLE_RPM, MAX_RPM, REDLINE_RPM } from '@keysrun/shared/sim/tach';

function $(id: string): HTMLElement | null { return document.getElementById(id); }

function nearestName(x: number, z: number): string {
  const s = shoreInfo(x, z);
  return (s.d < 120 ? 'off ' : 'toward ') + (s.isl ? s.isl.name : '');
}

export interface HudCtx {
  boatLabel: string;
  draft: number;
  running: boolean;
  /** This hull's top speed in knots — the speedometer's dial is re-ticked for it. */
  topKn: number;
}

let hudT = 0;
let lastHint = '';
/**
 * The dash, built on first update rather than at import: the HUD module is pulled in before the
 * document has the panel in it in some entry paths, and a cluster built against a missing host
 * is a silent no-op that is very hard to see.
 */
let dash: Dash | null = null;
let dialTopKn = 0;
/**
 * Our own copy of the revs.
 *
 * Stepped from the same model the engine synth runs (@keysrun/shared/sim/tach) rather than read
 * off it, so the tach still sweeps with the sound muted or before the AudioContext has been
 * allowed to start — which is most of the first minute of play.
 */
let rpm = IDLE_RPM;
const ACT = isTouch() ? '🎣' : 'Space';
void ACT; // kept for parity with legacy's touch-vs-keyboard action label, unused until fishing lands

export function updateHUD(dt: number, boat: BoatState, ctx: HudCtx): void {
  // The revs move on every frame, not on the 10 Hz gauge tick: a first-order lag sampled at
  // 10 Hz lands somewhere different from one sampled at 60, and this one has to match the synth.
  const kn = Math.abs(boat.speed) / SPEED_SCALE / 0.5144;
  rpm = boat.engineOn
    ? stepRpm(rpm, rpmTarget({
      throttle: boat.thr, speedFrac: kn / Math.max(1, ctx.topKn),
      trimV: boat.trimV, trimVent: boat.trimVent, gearRev: boat.gearRev,
    }), dt)
    : stepRpm(rpm, 0, dt);

  hudT -= dt;
  if (hudT > 0) return;
  hudT = 0.1;

  const host = $('gCluster');
  if (!dash && host) { dash = createDash(host, ctx.topKn, REDLINE_RPM, MAX_RPM); dialTopKn = ctx.topKn; }
  if (dash && ctx.topKn !== dialTopKn) { dash.setTopSpeed(ctx.topKn); dialTopKn = ctx.topKn; }
  if (dash) {
    dash.setTach(rpm, MAX_RPM);
    dash.setSpeed(kn);
    dash.setTrim(boat.trimV);
  }
  setText('gRpm', boat.engineOn ? String(Math.round(rpm / 10) * 10) : '—');
  setText('gSpd', kn.toFixed(0));
  setText('gHdg', String(Math.round((((-boat.h * 180 / Math.PI) % 360) + 360) % 360)).padStart(3, '0') + '°');
  const d = depthAt(boat.x, boat.z);
  setText('gDep', (d * 3.28).toFixed(1) + ' ft');
  const zn = zoneAt(boat.x, boat.z), of = offshoreF(boat.x, boat.z);
  setText('gZone', zn === 'Offshore' && of > 0.5 ? 'Deep blue water' : ZONE_DESC[zn]);
  setText('gNear', nearestName(boat.x, boat.z));
  setText('gTrimV', Math.round(boat.trimV * 100) + '%');
  setText('gTrimLbl', boat.trimMode ? 'Trim ▲▼' : 'Trim');
  $('gTrimDig')?.classList.toggle('on', boat.trimMode);
  const gGear = $('gGear');
  if (gGear) { gGear.textContent = boat.gear; gGear.className = 'g' + boat.gear; }
  setText('gWarn', d < ctx.draft ? 'Aground — back off to deeper water' : (d < ctx.draft + 0.4 && kn > 5 ? 'Shallow water ahead' : ''));
  setText('gBoat', ctx.boatLabel);

  let h: string;
  if (kn > 3) h = isTouch() ? '▲ ▼ throttle · ◀ ▶ steer · follow the chart' : 'W/S throttle · A/D steer · H changes the sea state';
  // Both of these needed a touch wording too. The moving case above already had one; stopped and
  // trimming did not, so a phone player sitting still was told to hold a key their device has not
  // got — which is the first instruction they ever see, since the boat starts stopped.
  else if (boat.trimMode) h = isTouch() ? 'Trim mode: ▲ trim up, ▼ trim down · T to exit' : 'Trim mode: ▲ trim up, ▼ trim down · W/S throttle · T to exit';
  else h = isTouch() ? 'Hold ▲ to get on the throttle · ◀ ▶ to steer · 🎥 switches camera view' : 'Hold W to get on the throttle · A/D to steer · 1 switches camera view';
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

