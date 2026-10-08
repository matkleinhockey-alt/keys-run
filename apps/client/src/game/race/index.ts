/**
 * Race mode: the button, the HUD, and the glue between the pure race state machine
 * (@keysrun/shared/sim/race), the course marks (buoys.ts) and the AI field (opponents.ts).
 *
 * Nothing here runs until the player starts a race. `createRaceMode` builds the buoys and the
 * three opponent hulls once at boot (so there is no hitch on the first press — `makeBoat` is the
 * expensive part and it is cache-backed anyway), leaves both groups `visible = false`, and
 * `update()` returns immediately while the phase is `idle`. Free when unused, which is what lets
 * this live in the normal frame loop rather than behind a lazy import.
 *
 * The player is just another entry in the field — id `'player'` — so the checkpoint logic,
 * standings and finishing order are the same code for everyone and there is no "player special
 * case" to get out of sync.
 */
import * as THREE from 'three';
import {
  MARATHON_COURSE, createRace, startRace, abortRace, stepRace, standings, syncRacers,
  buoyPos, courseLength, RACE_LAPS,
  type RaceState, type RacerPose,
} from '@keysrun/shared/sim/race';
import { createRaceBuoys, type RaceBuoys } from './buoys.js';
import { createRaceField, type RaceField } from './opponents.js';
import type { ParticleSystem } from '../../world/particles.js';

export interface RaceModeDeps {
  scene: THREE.Scene;
  /** Where to mount the race HUD — the same wrap the rest of the UI lives in. */
  wrap: HTMLElement;
  particles: ParticleSystem | null;
  /** Called with a short line whenever something race-worthy happens, so the existing toast
   * system reports it rather than this module growing its own notification UI. */
  toast(msg: string): void;
}

export interface RaceMode {
  /** Starts (or restarts) a race. Safe to call mid-race — it is a no-op then, see `startRace`. */
  start(): void;
  /** Abandons an in-progress race and hides everything. */
  abort(): void;
  /** Start if idle, abort if running — what the button and the hotkey both call. */
  toggle(): void;
  isActive(): boolean;
  /**
   * Once a frame with the player's boat position and, if connected, every other player's.
   *
   * Remote players are entered automatically: the course is deterministic and their positions are
   * already replicated, so each client scores the identical checkpoint logic over the same buoy
   * table and arrives at the same standings without any new network message.
   *
   * ⚠ What this does *not* do is synchronise the **start**. Each player presses their own button
   * and runs their own clock, so the ordering is honest but the elapsed times are only comparable
   * if you set off together. A shared countdown needs a server-coordinated message, which is
   * phase-5 work (docs/ARCHITECTURE.md) — flagged here rather than faked.
   */
  update(dt: number, t: number, boat: { x: number; z: number }, remotes?: readonly RemoteRacer[]): void;
  state(): RaceState;
  /** Verification-only: each AI boat's live position/speed/arc-length. */
  debugOpponents(): Array<{ id: string; name: string; x: number; z: number; speed: number; s: number }>;
  dispose(): void;
}

const PLAYER = 'player';
/** Id prefix for a networked opponent, keyed by its stable connection slot. */
const remoteId = (slotId: number): string => `net${slotId}`;

/** The slice of a remote boat race mode needs — see `RaceMode.update`. */
export interface RemoteRacer { slotId?: number; x: number; z: number }

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}

export function createRaceMode(deps: RaceModeDeps): RaceMode {
  const buoys: RaceBuoys = createRaceBuoys();
  const field: RaceField = createRaceField();
  deps.scene.add(buoys.group, field.group);

  const baseIds = [PLAYER, ...field.opponents.map((o) => o.id)];
  let race: RaceState = createRace(baseIds, RACE_LAPS);

  const nameOf = new Map<string, string>([[PLAYER, 'You'], ...field.opponents.map((o) => [o.id, o.name] as const)]);

  // --- HUD ---------------------------------------------------------------
  const hud = document.createElement('div');
  hud.className = 'raceHud';
  hud.setAttribute('aria-live', 'polite');
  hud.style.display = 'none';
  deps.wrap.appendChild(hud);

  // Rebuilt per frame because the networked field is not fixed — see `update`.
  let poses: RacerPose[] = baseIds.map((id) => ({ id, x: 0, z: 0 }));

  function playerProgress(): RaceState['racers'][number] | undefined {
    return race.racers.find((r) => r.id === PLAYER);
  }

  function renderHud(): void {
    if (race.phase === 'idle') { hud.style.display = 'none'; return; }
    hud.style.display = '';

    if (race.phase === 'countdown') {
      const n = Math.max(1, Math.ceil(race.clock));
      hud.innerHTML = `<div class="raceBig">${n}</div><div class="raceSub">${MARATHON_COURSE.length} marks · ${RACE_LAPS} laps · ${(courseLength() * RACE_LAPS / 1000).toFixed(1)} km</div>`;
      return;
    }

    const me = playerProgress();
    const order = standings(race);
    const myPlace = order.findIndex((r) => r.id === PLAYER) + 1;
    const fieldSize = race.racers.length;
    const rows = order.map((r, i) => {
      const t = r.finishT !== null ? fmtTime(r.finishT) : `L${r.lap + 1}`;
      return `<li${r.id === PLAYER ? ' class="me"' : ''}><b>${i + 1}</b> ${nameOf.get(r.id) ?? r.id} <span>${t}</span></li>`;
    }).join('');

    const markName = me ? MARATHON_COURSE[me.next].name : '';
    hud.innerHTML = `
      <div class="raceTop">
        <span class="racePlace">P${myPlace}<i>/${fieldSize}</i></span>
        <span class="raceLap">Lap ${Math.min(RACE_LAPS, (me?.lap ?? 0) + 1)}<i>/${RACE_LAPS}</i></span>
        <span class="raceClock">${fmtTime(race.clock)}</span>
      </div>
      ${race.phase === 'racing' ? `<div class="raceNext">Next: ${markName}</div>` : ''}
      <ol class="raceBoard">${rows}</ol>
      ${race.phase === 'finished' ? '<div class="raceSub">Press R to race again</div>' : ''}`;
  }

  // --- control -----------------------------------------------------------
  function start(): void {
    if (race.phase === 'countdown' || race.phase === 'racing') return;
    race = startRace(race);
    buoys.setVisible(true);
    field.setVisible(true);
    field.lineUp();
    renderHud();
    const startMark = buoyPos(MARATHON_COURSE[0]);
    deps.toast(`Race on — ${RACE_LAPS} laps of the Marathon course. Start is at ${Math.round(startMark.x)}, ${Math.round(startMark.z)}.`);
  }

  function abort(): void {
    race = abortRace(race);
    buoys.setVisible(false);
    field.setVisible(false);
    renderHud();
  }

  function toggle(): void {
    if (race.phase === 'idle' || race.phase === 'finished') start();
    else abort();
  }

  function isActive(): boolean { return race.phase !== 'idle'; }

  function update(dt: number, t: number, boat: { x: number; z: number }, remotes: readonly RemoteRacer[] = []): void {
    if (race.phase === 'idle') return;

    const released = race.phase === 'racing' || race.phase === 'finished';
    field.update(dt, t, released, deps.particles);

    // Entrants = you + the AI field + every connected player. Reconciled every frame because
    // players join and drop mid-race; `syncRacers` preserves existing progress and returns the
    // same reference when the field is unchanged, so the steady state allocates nothing.
    const netRacers = remotes.filter((r) => r.slotId !== undefined);
    const ids = [...baseIds, ...netRacers.map((r) => remoteId(r.slotId as number))];
    race = syncRacers(race, ids);

    if (poses.length !== ids.length) poses = ids.map((id) => ({ id, x: 0, z: 0 }));
    for (let i = 0; i < ids.length; i++) poses[i].id = ids[i];

    poses[0].x = boat.x; poses[0].z = boat.z;
    for (let i = 0; i < field.opponents.length; i++) {
      const o = field.opponents[i];
      poses[i + 1].x = o.x; poses[i + 1].z = o.z;
    }
    for (let i = 0; i < netRacers.length; i++) {
      const p = poses[baseIds.length + i];
      p.x = netRacers[i].x; p.z = netRacers[i].z;
      const id = p.id;
      if (!nameOf.has(id)) nameOf.set(id, `Player ${netRacers[i].slotId}`);
    }

    race = stepRace(race, poses, dt);

    for (const ev of race.events) {
      if (ev.type === 'go') deps.toast('GO!');
      else if (ev.type === 'lap' && ev.id === PLAYER) deps.toast(`Lap ${ev.lap} of ${RACE_LAPS}.`);
      else if (ev.type === 'finish') {
        if (ev.id === PLAYER) {
          const suffix = ev.place === 1 ? 'Won it.' : ev.place === 2 ? 'Second.' : `P${ev.place}.`;
          deps.toast(`Finished in ${fmtTime(ev.time)} — ${suffix}`);
        }
      }
    }

    const me = playerProgress();
    buoys.update(t, race.phase === 'racing' && me ? me.next : -1);
    renderHud();
  }

  function dispose(): void {
    deps.scene.remove(buoys.group, field.group);
    buoys.dispose();
    field.dispose();
    hud.remove();
  }

  function debugOpponents(): Array<{ id: string; name: string; x: number; z: number; speed: number; s: number }> {
    return field.opponents.map((o) => ({ id: o.id, name: o.name, x: o.x, z: o.z, speed: o.speed, s: o.s }));
  }

  return { start, abort, toggle, isActive, update, state: () => race, debugOpponents, dispose };
}
