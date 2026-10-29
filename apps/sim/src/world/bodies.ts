/**
 * Players' bodies off the boat — walking ashore, swimming, diving — relayed to whoever is near.
 *
 * A body is cosmetic: it carries no catch, no money and no collision, so unlike the boat it is not
 * shadow-simulated or envelope-checked. The sim keeps the latest AVATAR each player sent
 * (ConnMeta.body) and, with every snapshot, tells each player about the bodies within BODY_RADIUS_M
 * of where they are (their own body if they are off the boat, else their boat), nearest first.
 */
import { AVATAR_MODE, type AvatarsMsg } from '@keysrun/shared/proto';
import type { ConnMeta } from './connection.js';
import type { BoatEntities } from './entities.js';

/** Further than this, a person is a speck anyway. Boats are seen out to RADIUS_FAR_M (260 m). */
export const BODY_RADIUS_M = 400;
/** A body not heard from for this long is dropped (the client stopped sending: a closed tab, a crash). */
export const BODY_STALE_MS = 5000;
const MAX_BODIES = 63; // AVATARS_FIELDS' maxCount

export function setBody(conn: ConnMeta, msg: { mode: number; x: number; y: number; z: number; h: number; speed: number }, nowMs: number): void {
  if (msg.mode === AVATAR_MODE.NONE) { conn.body = null; return; }
  if (msg.mode !== AVATAR_MODE.WALK && msg.mode !== AVATAR_MODE.DIVE) return;
  conn.body = { mode: msg.mode, x: msg.x, y: msg.y, z: msg.z, h: msg.h, speed: msg.speed, atMs: nowMs };
}

/** The bodies `viewer` should see this snapshot. */
export function bodiesFor(viewer: ConnMeta, conns: ReadonlyMap<number, ConnMeta>, entities: BoatEntities, nowMs: number): AvatarsMsg {
  const vx = viewer.body ? viewer.body.x : entities.x[viewer.slot];
  const vz = viewer.body ? viewer.body.z : entities.z[viewer.slot];
  const near: { d2: number; slot: number; b: NonNullable<ConnMeta['body']> }[] = [];
  for (const [slot, c] of conns) {
    const b = c.body;
    if (slot === viewer.slot || !b) continue;
    if (nowMs - b.atMs > BODY_STALE_MS) { c.body = null; continue; }
    const d2 = (b.x - vx) ** 2 + (b.z - vz) ** 2;
    if (d2 <= BODY_RADIUS_M * BODY_RADIUS_M) near.push({ d2, slot, b });
  }
  near.sort((a, b) => a.d2 - b.d2);
  return {
    bodies: near.slice(0, MAX_BODIES).map(({ slot, b }) => ({ slotId: slot, mode: b.mode, x: b.x, y: b.y, z: b.z, h: b.h, speed: b.speed })),
  };
}
