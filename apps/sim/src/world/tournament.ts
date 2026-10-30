/**
 * The online tournament (packages/shared/src/sim/tournament.ts): one at a time, for everyone
 * connected. Anyone can start one; everyone online is entered, as is anyone who connects while
 * it runs. The rules are the shared module's — this only decides *who* (slots) and *when* (this
 * process's clock), checks a finish against the server's own copy of the boat, and tells everyone.
 *
 * Holds no socket: `broadcast`/`sendTo` come from the caller (app.ts / dispatch.ts), the same split
 * World keeps.
 */
import {
  createTourney, join, phaseOf, recordCatch, stepTourney, tryDeliver, isNpcId,
  TOURNEY_CEREMONY_S, TOURNEY_DURATION_S,
  type Tourney,
} from '@keysrun/shared/sim/tournament';
import type { TourneyMsg } from '@keysrun/shared/proto';
import type { World } from './world.js';

/** Once over, the result stays up this long (so late arrivals see who won) before the slot clears. */
const RESULT_HOLD_S = 60;
/** How often a running tournament is re-sent anyway, to keep every client's clock in step. */
const RESYNC_S = 5;

const slotId = (slot: number): string => `p${slot}`;
const slotOf = (id: string): number => Number(id.slice(1));

export class TourneyHost {
  private t: Tourney | null = null;
  private lastSentAt = -Infinity;
  private lastPhase: string | null = null;

  constructor(private world: World, private broadcast: (msg: TourneyMsg) => void) {}

  get current(): Tourney | null {
    return this.t;
  }

  /** A player pressed start. Ignored while one is running (countdown, live or ceremony). */
  start(nowS: number, seed: number): boolean {
    if (this.t && phaseOf(this.t, nowS) !== 'over') return false;
    this.t = createTourney(seed, nowS);
    for (const slot of this.world.conns.keys()) join(this.t, slotId(slot));
    this.send(nowS);
    return true;
  }

  /** A player connected: enter them if one is running. The caller sends them `message()`. */
  onConnect(slot: number, nowS: number): void {
    if (this.t && phaseOf(this.t, nowS) !== 'over') join(this.t, slotId(slot));
  }

  /** A player left: their slot can be handed to someone else, who must not inherit the catches.
   * A winner's entry stays (the result still names them until it clears). */
  onDisconnect(slot: number): void {
    const t = this.t;
    if (!t || t.winner?.id === slotId(slot)) return;
    t.entries = t.entries.filter((e) => e.id !== slotId(slot));
  }

  onCatch(slot: number, species: string, weight: number, nowS: number): void {
    if (!this.t) return;
    if (recordCatch(this.t, slotId(slot), species, weight, nowS) >= 0) this.send(nowS);
  }

  /** Judged on the server's boat — `entities` is what the envelope accepted, not the claim. */
  onDock(slot: number, nowS: number): void {
    if (!this.t || !this.world.conns.has(slot)) return;
    const e = this.world.entities;
    if (tryDeliver(this.t, slotId(slot), { x: e.x[slot], z: e.z[slot], speed: e.speed[slot] }, nowS)) this.send(nowS);
  }

  /** Call a few times a second: settles AI wins and the horn, re-sends on any change. */
  step(nowS: number): void {
    const t = this.t;
    if (!t) return;
    stepTourney(t, nowS);
    const phase = phaseOf(t, nowS);
    const endsAt = t.t0 + (t.winner ? t.winner.at + TOURNEY_CEREMONY_S : TOURNEY_DURATION_S);
    if (phase === 'over' && nowS > endsAt + RESULT_HOLD_S) {
      this.t = null;
      this.lastPhase = null;
      this.send(nowS);
      return;
    }
    if (phase !== this.lastPhase || (phase !== 'over' && nowS - this.lastSentAt >= RESYNC_S)) this.send(nowS);
  }

  message(nowS: number): TourneyMsg {
    const t = this.t;
    if (!t) return { active: false, seed: 0, clockMs: 0, winnerKind: 0, winnerId: 0, winAtMs: 0, winWeights: [], entries: [] };
    const w = t.winner;
    return {
      active: true,
      seed: t.seed,
      clockMs: Math.round((nowS - t.t0) * 1000),
      winnerKind: !w ? 0 : isNpcId(w.id) ? 2 : 1,
      winnerId: !w ? 0 : isNpcId(w.id) ? Number(w.id.slice(3)) : slotOf(w.id),
      winAtMs: w ? Math.round(w.at * 1000) : 0,
      winWeights: w ? w.weights.map((lb) => ({ lb })) : [],
      // Players who have gone offline drop off the board (their slot may be reused).
      entries: t.entries.filter((e) => this.world.conns.has(slotOf(e.id))).map((e) => ({ slotId: slotOf(e.id), mask: e.mask })),
    };
  }

  private send(nowS: number): void {
    this.lastSentAt = nowS;
    this.lastPhase = this.t ? phaseOf(this.t, nowS) : null;
    this.broadcast(this.message(nowS));
  }
}
