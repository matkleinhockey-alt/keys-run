/**
 * Where the tournament lives: on this machine (offline — you against the AI boats) or on the sim
 * server (online — everyone connected, plus the AI boats). The mode (index.ts) talks to a
 * `TourneyLink` and never needs to know which.
 *
 * Both hand back the same `Tourney` (@keysrun/shared/sim/tournament) on the link's own clock, so
 * every phase/standing/AI-progress question is answered by the shared functions either way. The
 * online link rebuilds its copy from each TOURNEY message: species and the AI boats follow from
 * the seed, the clock from `clockMs`, the board from `entries`.
 */
import {
  createTourney, drawSpecies, join, phaseOf, recordCatch, stepTourney, tryDeliver,
  TOURNEY_CEREMONY_S, TOURNEY_DURATION_S, TOURNEY_NPCS, isNpcId, npcId,
  type Tourney,
} from '@keysrun/shared/sim/tournament';
import type { TourneyMsg } from '@keysrun/shared/proto';
import type { NetClient } from '../../net/client.js';

export interface TourneyLink {
  readonly online: boolean;
  /** Seconds, on the clock `current()`'s times are in. */
  now(): number;
  current(): Tourney | null;
  /** Which entry is you. */
  selfId(): string;
  /** Display name for an entry id (your own included — the HUD says "You" itself). */
  nameOf(id: string): string;
  start(): void;
  /** Offline only: walk away from it. Online a tournament belongs to everyone and runs out. */
  abort?(): void;
  /** You kept a fish. */
  reportCatch(key: string, weight: number): void;
  /** You're in the harbour with all five (the link decides whether that wins). */
  reportDock(boat: { x: number; z: number; speed: number }): void;
  /** Once a frame. */
  step(): void;
}

/** Once the tournament is over, keep the result this long before the link forgets it. */
const RESULT_HOLD_S = 60;
/** DEV/VERIFICATION HOOK ONLY: `window.__tourneyClock`, when set, pins the clock (seconds) so a
 * screenshot script can hold the opening titles or the ceremony on one moment at this sandbox's
 * few frames a second. Unset in every normal run. */
const clock = (): number => (globalThis as { __tourneyClock?: number }).__tourneyClock ?? performance.now() / 1000;

function npcName(id: string): string {
  const n = TOURNEY_NPCS[Number(id.slice(3))];
  return n ? n.captain : id;
}

export function createLocalLink(): TourneyLink {
  const ME = 'me';
  let t: Tourney | null = null;
  return {
    online: false,
    now: clock,
    current: () => t,
    selfId: () => ME,
    nameOf: (id) => (id === ME ? 'You' : isNpcId(id) ? npcName(id) : id),
    start() {
      if (t && phaseOf(t, clock()) !== 'over') return;
      t = createTourney((Math.random() * 0x100000000) >>> 0, clock());
      join(t, ME);
    },
    abort() { t = null; },
    reportCatch(key, weight) { if (t) recordCatch(t, ME, key, weight, clock()); },
    reportDock(boat) { if (t) tryDeliver(t, ME, boat, clock()); },
    step() {
      if (!t) return;
      const now = clock();
      stepTourney(t, now);
      const end = t.t0 + (t.winner ? t.winner.at + TOURNEY_CEREMONY_S : TOURNEY_DURATION_S);
      if (phaseOf(t, now) === 'over' && now > end + RESULT_HOLD_S) t = null;
    },
  };
}

/** The online link. `onTourney` must be wired to the NetClient's event of the same name. */
export function createNetLink(net: NetClient, myName: string): TourneyLink & { onTourney(msg: TourneyMsg): void } {
  let t: Tourney | null = null;
  // Your own weights: the server only sends the board as masks, but the ceremony wants weights if
  // the winner is you, and those are yours to remember.
  let mine: { seed: number; weights: Map<string, number> } = { seed: -1, weights: new Map() };
  let lastDockAt = -Infinity;
  const self = (): string => `p${net.slotId ?? -1}`;
  return {
    online: true,
    now: clock,
    current: () => t,
    selfId: self,
    nameOf(id) {
      if (id === self()) return myName;
      if (isNpcId(id)) return npcName(id);
      const slot = Number(id.slice(1));
      return net.nameOf(slot) ?? `Player ${slot}`;
    },
    start() { net.sendTourneyStart(); },
    reportCatch(key, weight) {
      if (!t) return;
      // Applied here at once (the server's answer follows and overwrites it) so the checklist
      // ticks the moment you keep the fish, not a round trip later.
      if (recordCatch(t, self(), key, weight, clock()) >= 0) {
        if (mine.seed !== t.seed) mine = { seed: t.seed, weights: new Map() };
        mine.weights.set(key, weight);
        net.sendTourneyCatch(key, weight);
      }
    },
    reportDock() {
      // The server judges it on its own copy of the boat; asking once a second is plenty.
      if (clock() - lastDockAt < 1) return;
      lastDockAt = clock();
      net.sendTourneyDock();
    },
    step() { /* the server keeps the clock */ },
    onTourney(msg) {
      if (!msg.active) { t = null; return; }
      const now = clock();
      const species = drawSpecies(msg.seed);
      const fresh: Tourney = {
        seed: msg.seed,
        species,
        t0: now - msg.clockMs / 1000,
        entries: msg.entries.map((e) => ({
          id: `p${e.slotId}`,
          mask: e.mask,
          weights: species.map((k, i) => ((e.mask >> i) & 1 && `p${e.slotId}` === self() && mine.seed === msg.seed ? mine.weights.get(k) ?? 0 : 0)),
        })),
        winner: msg.winnerKind === 0 ? null : {
          id: msg.winnerKind === 2 ? npcId(msg.winnerId) : `p${msg.winnerId}`,
          at: msg.winAtMs / 1000,
          weights: msg.winWeights.map((w) => w.lb),
        },
      };
      // Keep the clock steady across resyncs: only take the new zero if it moved noticeably (a
      // late packet shouldn't make the countdown stutter by a few frames).
      if (t && t.seed === fresh.seed && Math.abs(t.t0 - fresh.t0) < 0.25) fresh.t0 = t.t0;
      t = fresh;
    },
  };
}
