import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { TourneyHost } from '../src/world/tournament.js';
import { BOATS } from '@keysrun/shared/content/boats';
import type { BoatHull } from '@keysrun/shared/sim/boat';
import { HARBOUR, TOURNEY_COUNTDOWN_S, TOURNEY_NPCS, TOURNEY_DURATION_S, npcPlan } from '@keysrun/shared/sim/tournament';
import type { TourneyMsg } from '@keysrun/shared/proto';

const HULLS: BoatHull[] = BOATS.map((b) => ({ len: b.len, beam: b.beam, top: b.top, accel: b.accel, turn: b.turn, draft: b.draft, cat: b.cat }));
const T0 = 50_000;
const live = (s: number): number => T0 + TOURNEY_COUNTDOWN_S + s;

/** A seed whose AI boats stay out the whole tournament, so only players can win. */
const QUIET_SEED = (() => {
  for (let s = 1; ; s++) if (TOURNEY_NPCS.every((_, i) => npcPlan(s, i).homeAt > TOURNEY_DURATION_S)) return s;
})();

function setup() {
  const world = new World(16, (i) => HULLS[i] ?? HULLS[0]);
  const sent: TourneyMsg[] = [];
  const host = new TourneyHost(world, (m) => sent.push(m));
  const a = world.connectPlayer('ua', 0, { x: 0, z: 0, h: 0, speed: 0 }, () => {}, 0)!.slot;
  const b = world.connectPlayer('ub', 0, { x: 0, z: 0, h: 0, speed: 0 }, () => {}, 0)!.slot;
  return { world, host, sent, a, b };
}

function putInHarbour(world: World, slot: number, speed = 0): void {
  world.entities.x[slot] = HARBOUR.x;
  world.entities.z[slot] = HARBOUR.z;
  world.entities.speed[slot] = speed;
}

describe('online tournament host', () => {
  it('starts one for everyone connected, and refuses a second while it runs', () => {
    const { host, sent, a, b } = setup();
    expect(host.start(T0, QUIET_SEED)).toBe(true);
    expect(host.start(T0 + 1, 99)).toBe(false);
    const m = sent.at(-1)!;
    expect(m.active).toBe(true);
    expect(m.seed).toBe(QUIET_SEED);
    expect(m.clockMs).toBe(-TOURNEY_COUNTDOWN_S * 1000);
    expect(m.entries.map((e) => e.slotId).sort()).toEqual([a, b].sort());
  });

  it('judges the finish on the server boat, not on a claim', () => {
    const { world, host, sent, a } = setup();
    host.start(T0, QUIET_SEED);
    for (const key of host.current!.species) host.onCatch(a, key, 12.5, live(30));
    // Server still has the boat out at sea: no win, whatever the client thinks.
    host.onDock(a, live(60));
    expect(host.current!.winner).toBeNull();
    putInHarbour(world, a, 9); // in the harbour but still running hard
    host.onDock(a, live(61));
    expect(host.current!.winner).toBeNull();
    putInHarbour(world, a);
    host.onDock(a, live(62));
    expect(host.current!.winner?.id).toBe(`p${a}`);
    const m = sent.at(-1)!;
    expect(m.winnerKind).toBe(1);
    expect(m.winnerId).toBe(a);
    expect(m.winWeights.map((w) => w.lb)).toEqual([12.5, 12.5, 12.5, 12.5, 12.5]);
  });

  it('a player who leaves takes their catches with them; a newcomer joins at zero', () => {
    const { world, host, a } = setup();
    host.start(T0, QUIET_SEED);
    host.onCatch(a, host.current!.species[0], 5, live(10));
    host.onDisconnect(a);
    world.disconnectPlayer(a);
    const c = world.connectPlayer('uc', 0, { x: 0, z: 0, h: 0, speed: 0 }, () => {}, 0)!.slot;
    expect(c).toBe(a); // same slot handed out again
    host.onConnect(c, live(20));
    expect(host.message(live(20)).entries.find((e) => e.slotId === c)?.mask).toBe(0);
  });

  it('settles an AI win on its own clock and clears a minute after it ends', () => {
    let seed = 1;
    while (Math.min(...TOURNEY_NPCS.map((_, i) => npcPlan(seed, i).homeAt)) > TOURNEY_DURATION_S - 30) seed++;
    const first = Math.min(...TOURNEY_NPCS.map((_, i) => npcPlan(seed, i).homeAt));
    const { host, sent } = setup();
    host.start(T0, seed);
    host.step(live(first + 1));
    expect(sent.at(-1)!.winnerKind).toBe(2);
    host.step(live(first + 200));
    expect(sent.at(-1)!.active).toBe(false);
  });
});
