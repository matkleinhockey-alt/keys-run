/**
 * The tournament's opening titles, over the countdown: letterbox bars, an aerial push over Boot Key
 * Harbor with the five species, then a shot of every boat in the field with its skipper's name
 * across the bottom of the screen — the AI captains lined up abreast in the harbour, you, your
 * friends wherever they are on the water — and "LINES IN" as the gun goes.
 *
 * Time-indexed, not stateful: `shotAt(s)` is a pure function of seconds into the countdown, so a
 * friend who joins two seconds late sees the same shot everyone else is seeing, and a resync that
 * nudges the clock just nudges the cut.
 */
import * as THREE from 'three';
import { SPECIES } from '@keysrun/shared/content/species';
import { seaHAt } from '@keysrun/shared/sim/depth-grid';
import { HARBOUR, TOURNEY_COUNTDOWN_S, TOURNEY_DURATION_S } from '@keysrun/shared/sim/tournament';
import type { Shot } from './ceremony.js';

export interface IntroEntrant {
  name: string;
  /** Second line: the boat. */
  boat: string;
  /** Where the boat is now (heading as the boat group's rotation.y), or null if not in view. */
  pose(): { x: number; z: number; h: number } | null;
}

const TITLE_S = 3.2;
const GUN_S = 0.9;
/** More boats than this and the extras share the last card — every shot needs ~1.8 s to read. */
const MAX_BOAT_SHOTS = Math.floor((TOURNEY_COUNTDOWN_S - TITLE_S - GUN_S) / 1.8);

export interface IntroCard { kind: 'title' | 'boat' | 'gun'; title: string; sub: string; chips?: string[] }

export interface IntroPlan {
  /** Camera and card at `s` seconds into the countdown. */
  at(s: number, t: number): { shot: Shot; card: IntroCard; cardKey: string };
}

const fmtMin = (s: number): string => `${Math.round(s / 60)} minutes`;

export function planIntro(species: readonly string[], entrants: readonly IntroEntrant[], fleetCentre: () => { x: number; z: number; h: number }): IntroPlan {
  const shown = entrants.slice(0, MAX_BOAT_SHOTS);
  const extra = entrants.length - shown.length;
  const boatS = (TOURNEY_COUNTDOWN_S - TITLE_S - GUN_S) / Math.max(1, shown.length);
  const title: IntroCard = {
    kind: 'title',
    title: 'Keys Run Fishing Tournament',
    sub: `${fmtMin(TOURNEY_DURATION_S)} · one of each · first back to ${HARBOUR.name} wins`,
    chips: species.map((k) => SPECIES[k]?.name ?? k),
  };

  /** A slow dolly past the boat's quarter, alternating sides shot to shot. */
  function boatShot(p: { x: number; z: number; h: number }, u: number, side: number, t: number): Shot {
    const fx = -Math.sin(p.h), fz = -Math.cos(p.h); // boat forward (entities/boat/visuals.ts)
    const rx = Math.cos(p.h), rz = -Math.sin(p.h);
    const along = 5 - u * 4, out = 9 - u * 1.5;
    const pos = new THREE.Vector3(p.x + fx * along + rx * out * side, 0, p.z + fz * along + rz * out * side);
    pos.y = Math.max(seaHAt(pos.x, pos.z, t) + 1.4, 2.6 + u * 0.4);
    return { pos, look: new THREE.Vector3(p.x + fx * 1.5, 1.6, p.z + fz * 1.5) };
  }

  return {
    at(s, t) {
      if (s < TITLE_S) {
        const u = s / TITLE_S;
        const c = fleetCentre();
        return {
          shot: { pos: new THREE.Vector3(HARBOUR.x + 160 - u * 70, 70 - u * 28, HARBOUR.z - 140 + u * 60), look: new THREE.Vector3(c.x, 0, c.z) },
          card: title, cardKey: 'title',
        };
      }
      const k = Math.floor((s - TITLE_S) / boatS);
      if (s < TOURNEY_COUNTDOWN_S - GUN_S && k < shown.length) {
        const e = shown[k];
        const u = (s - TITLE_S - k * boatS) / boatS;
        const p = e.pose() ?? fleetCentre();
        const last = k === shown.length - 1 && extra > 0;
        return {
          shot: boatShot(p, u, k % 2 ? -1 : 1, t),
          card: { kind: 'boat', title: e.name, sub: last ? `${e.boat} · and ${extra} more` : e.boat },
          cardKey: `boat${k}`,
        };
      }
      // The gun: high behind the fleet, looking out the way they're about to go.
      const c = fleetCentre();
      const fx = -Math.sin(c.h), fz = -Math.cos(c.h);
      return {
        shot: { pos: new THREE.Vector3(c.x - fx * 40, 16, c.z - fz * 40), look: new THREE.Vector3(c.x + fx * 30, 0, c.z + fz * 30) },
        card: { kind: 'gun', title: 'Lines in', sub: `${fmtMin(TOURNEY_DURATION_S)} on the clock` },
        cardKey: 'gun',
      };
    },
  };
}
