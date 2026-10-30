/**
 * Per-connection protocol handshake and message dispatch: HELLO -> session/resume lookup ->
 * WELCOME|REJECT, then INPUT/PING while connected. This is the only place that bridges a
 * `TransportConnection` (net/transport.ts) to `World` — World itself never sees a socket.
 */
import type { Pool } from 'pg';
import { BitReader, decodeMessageBody, readMessageId } from '@keysrun/shared/proto';
import { AVATAR_FIELDS, HELLO_FIELDS, INPUT_FIELDS, MSG, PING_FIELDS, RejectReason, TOURNEY_CATCH_FIELDS, decodeSpeciesKey, encodePeerName } from '@keysrun/shared/proto';
import type { TransportConnection } from './transport.js';
import type { World, Spawn } from '../world/world.js';
import { resolveSessionToken } from '../db/sessions.js';
import { loadResume } from '../db/players.js';
import { encodePeer, encodePong, encodeReject, encodeTourney, encodeWelcome } from './encode.js';
import { setBody } from '../world/bodies.js';
import type { TourneyHost } from '../world/tournament.js';

const SMALL_SCRATCH = new Uint8Array(64);

export interface DispatchContext {
  world: World;
  pool: Pool;
  defaultSpawn: () => Spawn;
  defaultHullIndex: () => number;
  /** Observability hook — bumped on every rejected/invalid auth attempt. */
  onAuthRejected?: (reason: string) => void;
  /** The online tournament (world/tournament.ts). Optional so tests that only exercise boats can
   * leave it out. */
  tourney?: TourneyHost;
}

const TOURNEY_SCRATCH = new Uint8Array(512);
const nowS = (): number => Date.now() / 1000;

export function attachConnection(conn: TransportConnection, ctx: DispatchContext): void {
  let slot: number | null = null;
  let authenticated = false;

  async function handleHello(reader: BitReader): Promise<void> {
    const hello = decodeMessageBody(HELLO_FIELDS, reader);
    const tokenHex = Buffer.from(hello.token).toString('hex');
    const session = await resolveSessionToken(ctx.pool, tokenHex);
    if (!session) {
      conn.send(encodeReject(SMALL_SCRATCH, { reason: RejectReason.INVALID_TOKEN }));
      ctx.onAuthRejected?.('invalid-token');
      conn.close(4003, 'invalid token');
      return;
    }

    const resume = await loadResume(ctx.pool, session.userId);
    const spawn: Spawn = resume ? { x: resume.x, z: resume.z, h: resume.h, speed: resume.speed } : ctx.defaultSpawn();
    const hullIndex = resume ? resume.hullIndex : ctx.defaultHullIndex();

    const result = ctx.world.connectPlayer(session.userId, hullIndex, spawn, conn.send, Date.now());
    if (!result) {
      conn.send(encodeReject(SMALL_SCRATCH, { reason: RejectReason.SERVER_FULL }));
      ctx.onAuthRejected?.('server-full');
      conn.close(4004, 'server full');
      return;
    }

    slot = result.slot;
    authenticated = true;
    conn.send(
      encodeWelcome(SMALL_SCRATCH, {
        slotId: result.slot,
        hullIndex: result.hullIndex,
        tick: result.tick,
        x: result.x,
        z: result.z,
        h: result.h,
        speed: result.speed,
      }),
    );

    // Names for nametags: everyone already here to the newcomer, and the newcomer to everyone.
    const me = ctx.world.conns.get(result.slot);
    if (me) me.name = session.displayName;
    const mine = encodePeer(SMALL_SCRATCH, { slotId: result.slot, name: encodePeerName(session.displayName) }).slice();
    for (const [s, c] of ctx.world.conns) {
      if (s === result.slot) continue;
      c.send(mine);
      conn.send(encodePeer(SMALL_SCRATCH, { slotId: s, name: encodePeerName(c.name) }));
    }

    // A tournament already running: enter the newcomer and show them where it stands.
    if (ctx.tourney) {
      ctx.tourney.onConnect(result.slot, nowS());
      conn.send(encodeTourney(TOURNEY_SCRATCH, ctx.tourney.message(nowS())));
    }
  }

  conn.onMessage((bytes) => {
    const reader = new BitReader(bytes);
    const id = readMessageId(reader);

    if (!authenticated) {
      if (id !== MSG.HELLO) {
        conn.close(4002, 'expected HELLO');
        return;
      }
      void handleHello(reader);
      return;
    }

    if (slot === null) return;

    if (id === MSG.INPUT) {
      const input = decodeMessageBody(INPUT_FIELDS, reader);
      ctx.world.onInput(slot, input, Date.now());
    } else if (id === MSG.AVATAR) {
      const c = ctx.world.conns.get(slot);
      if (c) setBody(c, decodeMessageBody(AVATAR_FIELDS, reader), Date.now());
    } else if (id === MSG.TOURNEY_START) {
      // A fresh seed every time — this is what makes the five species different each tournament.
      ctx.tourney?.start(nowS(), (Math.random() * 0x100000000) >>> 0);
    } else if (id === MSG.TOURNEY_CATCH) {
      const m = decodeMessageBody(TOURNEY_CATCH_FIELDS, reader);
      ctx.tourney?.onCatch(slot, decodeSpeciesKey(m.species), m.weight, nowS());
    } else if (id === MSG.TOURNEY_DOCK) {
      ctx.tourney?.onDock(slot, nowS());
    } else if (id === MSG.PING) {
      const ping = decodeMessageBody(PING_FIELDS, reader);
      conn.send(encodePong(SMALL_SCRATCH, { clientTimeMs: ping.clientTimeMs, serverTimeMs: Date.now() >>> 0 }));
    }
  });

  conn.onClose(() => {
    if (slot !== null) {
      ctx.tourney?.onDisconnect(slot);
      ctx.world.disconnectPlayer(slot);
    }
  });
}
