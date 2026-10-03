import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { buildSnapshot } from '../src/net/snapshot.js';
import { BOATS } from '@keysrun/shared/content/boats';
import { createBoatState, stepBoat, type BoatEnv, type BoatHull, type BoatInput, type BoatState } from '@keysrun/shared/sim/boat';
import { DEFAULT_CH, DEFAULT_SW } from '@keysrun/shared/waves';
import { WB } from '@keysrun/shared/world/depth';

const HULL_TABLE: BoatHull[] = BOATS.map((b) => ({ len: b.len, beam: b.beam, top: b.top, accel: b.accel, turn: b.turn, draft: b.draft, cat: b.cat }));
function hullOf(index: number): BoatHull {
  return HULL_TABLE[index] ?? HULL_TABLE[0];
}

/** Collects every Uint8Array a fake connection's `send` is called with — World never touches a real socket. */
function fakeSend(sink: Uint8Array[]) {
  return (bytes: Uint8Array) => sink.push(bytes.slice());
}

const DT = 1 / 30;
const NEUTRAL: BoatInput = { fwd: false, back: false, left: false, right: false, trimUp: false, trimDn: false };

/**
 * A *real* synthetic client: runs the actual full-physics stepBoat (never the dumb "echo the
 * server's last known state" a naive test double would use) and reports its own x/z/h/speed —
 * exactly what docs/ARCHITECTURE.md's authority model expects a real client to do. Driving
 * World with this is what makes these tests a meaningful check of tick()/reconcileBoat wiring
 * rather than of a stand-in that happens to never move.
 */
function makeRealClient(hull: BoatHull, x: number, z: number, h: number) {
  let state: BoatState = createBoatState(x, z, h);
  let t = 0;
  function envAt(): BoatEnv {
    return {
      t,
      hull,
      sw: DEFAULT_SW,
      ch: DEFAULT_CH,
      worldBounds: WB,
      pilings: [],
      dockRects: [],
      canDrive: true,
      fightActive: false,
      fightTarget: null,
      lineOut: false,
      luigiOn: false,
    };
  }
  return {
    step(input: BoatInput): BoatState {
      state = stepBoat(state, input, envAt(), DT);
      t += DT;
      return state;
    },
    get state() {
      return state;
    },
  };
}

describe('World', () => {
  it('connectPlayer allocates a slot and spawns at the given position', () => {
    const world = new World(8, hullOf);
    const sink: Uint8Array[] = [];
    const result = world.connectPlayer('user-1', 0, { x: 10, z: 1400, h: 0, speed: 0 }, fakeSend(sink), 0);
    expect(result).not.toBeNull();
    expect(result?.slot).toBe(0);
    expect(world.entities.used[0]).toBe(1);
    expect(world.entities.x[0]).toBe(10);
    expect(world.entities.z[0]).toBe(1400);
  });

  it('rejects a new connection once at capacity', () => {
    const world = new World(2, hullOf);
    const sink: Uint8Array[] = [];
    expect(world.connectPlayer('a', 0, { x: 0, z: 1400, h: 0, speed: 0 }, fakeSend(sink), 0)).not.toBeNull();
    expect(world.connectPlayer('b', 0, { x: 0, z: 1400, h: 0, speed: 0 }, fakeSend(sink), 0)).not.toBeNull();
    expect(world.connectPlayer('c', 0, { x: 0, z: 1400, h: 0, speed: 0 }, fakeSend(sink), 0)).toBeNull();
  });

  it('disconnectPlayer frees the slot for reuse and removes it from the interest grid', () => {
    const world = new World(2, hullOf);
    const sink: Uint8Array[] = [];
    const result = world.connectPlayer('a', 0, { x: 0, z: 1400, h: 0, speed: 0 }, fakeSend(sink), 0);
    const slot = result!.slot;
    world.disconnectPlayer(slot);
    expect(world.entities.used[slot]).toBe(0);
    const again = world.connectPlayer('b', 0, { x: 0, z: 1400, h: 0, speed: 0 }, fakeSend(sink), 0);
    expect(again?.slot).toBe(slot); // freed slot reused
  });

  it('tick() drives a boat forward under sustained forward throttle input', () => {
    const world = new World(4, hullOf);
    const sink: Uint8Array[] = [];
    const result = world.connectPlayer('a', 0, { x: 0, z: 1400, h: 0, speed: 0 }, fakeSend(sink), 0);
    const slot = result!.slot;
    const client = makeRealClient(hullOf(0), 0, 1400, 0);

    for (let i = 0; i < 90; i++) {
      const s = client.step({ ...NEUTRAL, fwd: true });
      world.onInput(slot, { seq: i, ackTick: 0, fwd: true, back: false, left: false, right: false, trimUp: false, trimDn: false, x: s.x, z: s.z, h: s.h, speed: s.speed }, i * 33);
      world.tick(i * 33);
    }

    expect(world.entities.speed[slot]).toBeGreaterThan(5);
    expect(world.totalViolations).toBe(0); // a real client's reports never violate
  });

  it('two boats within range subscribe to each other after interest evaluation ticks run', () => {
    const world = new World(4, hullOf);
    const sinkA: Uint8Array[] = [];
    const sinkB: Uint8Array[] = [];
    const a = world.connectPlayer('a', 0, { x: 0, z: 1400, h: 0, speed: 0 }, fakeSend(sinkA), 0)!;
    const b = world.connectPlayer('b', 0, { x: 50, z: 1400, h: 0, speed: 0 }, fakeSend(sinkB), 0)!;
    const clientA = makeRealClient(hullOf(0), 0, 1400, 0);
    const clientB = makeRealClient(hullOf(0), 50, 1400, 0);

    for (let i = 0; i < 16; i++) {
      const sa = clientA.step(NEUTRAL);
      const sb = clientB.step(NEUTRAL);
      world.onInput(a.slot, { seq: i, ackTick: 0, fwd: false, back: false, left: false, right: false, trimUp: false, trimDn: false, x: sa.x, z: sa.z, h: sa.h, speed: sa.speed }, i * 33);
      world.onInput(b.slot, { seq: i, ackTick: 0, fwd: false, back: false, left: false, right: false, trimUp: false, trimDn: false, x: sb.x, z: sb.z, h: sb.h, speed: sb.speed }, i * 33);
      world.tick(i * 33);
    }

    const connA = world.conns.get(a.slot)!;
    const connB = world.conns.get(b.slot)!;
    expect(connA.subscriptions.has(b.slot)).toBe(true);
    expect(connB.subscriptions.has(a.slot)).toBe(true);
  });

  it('buildSnapshot includes a subscribed boat and reports its current position', () => {
    const world = new World(4, hullOf);
    const sinkA: Uint8Array[] = [];
    const sinkB: Uint8Array[] = [];
    const a = world.connectPlayer('a', 0, { x: 0, z: 1400, h: 0, speed: 0 }, fakeSend(sinkA), 0)!;
    const b = world.connectPlayer('b', 1, { x: 20, z: 1400, h: 0, speed: 0 }, fakeSend(sinkB), 0)!;
    const clientA = makeRealClient(hullOf(0), 0, 1400, 0);
    const clientB = makeRealClient(hullOf(1), 20, 1400, 0);

    for (let i = 0; i < 16; i++) {
      const sa = clientA.step(NEUTRAL);
      const sb = clientB.step(NEUTRAL);
      world.onInput(a.slot, { seq: i, ackTick: 0, fwd: false, back: false, left: false, right: false, trimUp: false, trimDn: false, x: sa.x, z: sa.z, h: sa.h, speed: sa.speed }, i * 33);
      world.onInput(b.slot, { seq: i, ackTick: 0, fwd: false, back: false, left: false, right: false, trimUp: false, trimDn: false, x: sb.x, z: sb.z, h: sb.h, speed: sb.speed }, i * 33);
      world.tick(i * 33);
    }

    const connA = world.conns.get(a.slot)!;
    const snap = buildSnapshot({ tick: world.currentTick, conn: connA, entities: world.entities, snapshotCounter: 0, scratchCandidates: [] });
    expect(snap.spawns.some((s) => s.slotId === b.slot && s.hullIndex === 1)).toBe(true);
    const boatEntry = snap.boats.find((bt) => bt.slotId === b.slot);
    expect(boatEntry).toBeDefined();
    expect(boatEntry?.x).toBeCloseTo(20, 1);
  });

  it('a hard envelope violation flags correctedSinceSnapshot and is visible to other subscribers', () => {
    const world = new World(4, hullOf);
    const sinkA: Uint8Array[] = [];
    const sinkB: Uint8Array[] = [];
    const a = world.connectPlayer('a', 0, { x: 0, z: 1400, h: 0, speed: 0 }, fakeSend(sinkA), 0)!;
    world.connectPlayer('b', 0, { x: 5, z: 1400, h: 0, speed: 0 }, fakeSend(sinkB), 0)!;

    // "a" reports a wild teleport.
    world.onInput(a.slot, { seq: 0, ackTick: 0, fwd: false, back: false, left: false, right: false, trimUp: false, trimDn: false, x: 5000, z: 5000, h: 0, speed: 0 }, 0);
    world.tick(0);

    expect(world.entities.correctedSinceSnapshot[a.slot]).toBe(1);
    expect(world.totalViolations).toBe(1);
    // Position was NOT accepted — stayed near the shadow's (spawn) position, not the claimed teleport.
    expect(world.entities.x[a.slot]).toBeLessThan(100);
  });
});
