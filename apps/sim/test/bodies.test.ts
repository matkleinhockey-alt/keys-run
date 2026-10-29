/**
 * world/bodies.ts: who sees whose body (walking ashore, diving), and the AVATARS / PEER wire round
 * trip a client decodes.
 */
import { describe, expect, it } from 'vitest';
import { World } from '../src/world/world.js';
import { bodiesFor, setBody, BODY_RADIUS_M, BODY_STALE_MS } from '../src/world/bodies.js';
import { encodeAvatars, encodePeer } from '../src/net/encode.js';
import { AVATARS_FIELDS, AVATAR_MODE, BitReader, PEER_FIELDS, decodeMessageBody, decodePeerName, encodePeerName, readMessageId, MSG } from '@keysrun/shared/proto';
import { BOATS } from '@keysrun/shared/content/boats';
import type { BoatHull } from '@keysrun/shared/sim/boat';

const hull = (i: number): BoatHull => { const b = BOATS[i] ?? BOATS[0]; return { len: b.len, beam: b.beam, top: b.top, accel: b.accel, turn: b.turn, draft: b.draft, cat: b.cat }; };

function world3() {
  const w = new World(16, hull);
  const t = 1000;
  const a = w.connectPlayer('a', 0, { x: 0, z: 0, h: 0, speed: 0 }, () => {}, t)!.slot;
  const b = w.connectPlayer('b', 0, { x: 50, z: 0, h: 0, speed: 0 }, () => {}, t)!.slot;
  const c = w.connectPlayer('c', 0, { x: 3000, z: 0, h: 0, speed: 0 }, () => {}, t)!.slot;
  return { w, a, b, c, conn: (s: number) => w.conns.get(s)! };
}

describe('bodies', () => {
  it('shows a nearby walker or diver, not your own body, not someone far away, nobody aboard', () => {
    const { w, a, b, c, conn } = world3();
    setBody(conn(b), { mode: AVATAR_MODE.WALK, x: 60, y: 1.5, z: 10, h: 1, speed: 1.4 }, 1000);
    setBody(conn(c), { mode: AVATAR_MODE.DIVE, x: 3000, y: -12, z: 0, h: 0, speed: 0.5 }, 1000);
    setBody(conn(a), { mode: AVATAR_MODE.DIVE, x: 0, y: -5, z: 0, h: 0, speed: 0 }, 1000);
    const seen = bodiesFor(conn(a), w.conns, w.entities, 1100).bodies;
    expect(seen.map((s) => s.slotId)).toEqual([b]);
    expect(seen[0]).toMatchObject({ mode: AVATAR_MODE.WALK, x: 60, y: 1.5, z: 10 });
    // climbing back aboard takes the body away
    setBody(conn(b), { mode: AVATAR_MODE.NONE, x: 0, y: 0, z: 0, h: 0, speed: 0 }, 1200);
    expect(bodiesFor(conn(a), w.conns, w.entities, 1300).bodies).toEqual([]);
  });

  it('measures from your body when you are off the boat, and drops bodies that went quiet', () => {
    const { w, a, c, conn } = world3();
    setBody(conn(c), { mode: AVATAR_MODE.WALK, x: 3000, y: 1, z: 0, h: 0, speed: 0 }, 1000);
    expect(bodiesFor(conn(a), w.conns, w.entities, 1000).bodies).toEqual([]);
    // a walked far from their boat, to within range of c
    setBody(conn(a), { mode: AVATAR_MODE.WALK, x: 3000 - BODY_RADIUS_M + 10, y: 1, z: 0, h: 0, speed: 0 }, 1000);
    expect(bodiesFor(conn(a), w.conns, w.entities, 1000).bodies.map((s) => s.slotId)).toEqual([c]);
    expect(bodiesFor(conn(a), w.conns, w.entities, 1000 + BODY_STALE_MS + 1).bodies).toEqual([]);
  });

  it('round-trips AVATARS and PEER on the wire', () => {
    const { w, a, b, conn } = world3();
    setBody(conn(b), { mode: AVATAR_MODE.DIVE, x: 60, y: -21.3, z: 10, h: -2, speed: 1.1 }, 1000);
    const bytes = encodeAvatars(new Uint8Array(4096), bodiesFor(conn(a), w.conns, w.entities, 1000)).slice();
    const r = new BitReader(bytes);
    expect(readMessageId(r)).toBe(MSG.AVATARS);
    const got = decodeMessageBody(AVATARS_FIELDS, r).bodies[0];
    expect(got.slotId).toBe(b);
    expect(got.mode).toBe(AVATAR_MODE.DIVE);
    expect(got.y).toBeCloseTo(-21.3, 1);
    expect(got.x).toBeCloseTo(60, 0);

    const p = new BitReader(encodePeer(new Uint8Array(64), { slotId: b, name: encodePeerName('Larry Ü 🐟') }).slice());
    expect(readMessageId(p)).toBe(MSG.PEER);
    const peer = decodeMessageBody(PEER_FIELDS, p);
    expect(peer.slotId).toBe(b);
    expect(decodePeerName(peer.name)).toBe('Larry Ü 🐟');
  });
});
