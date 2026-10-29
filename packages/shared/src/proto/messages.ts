/**
 * The message table: every wire message Keys Run's `sim` service sends or receives, as one
 * `FieldSchema[]` per type (see schema.ts/codec.ts for why that's the whole codec). Scope is
 * boat replication, plus the player's body when it is off the boat (AVATAR/AVATARS, PEER: walking
 * ashore or in the water); rod fishing (CAST/STRIKE/CATCH) and spear messages are later phases.
 *
 * Quantization ranges (`Q`) are picked against the world's real bounds (`WB`, padded) and the
 * boat envelope's speed ceiling (see envelope.ts's 1.12x-over-hull-top headroom) — property
 * tests in test/proto.property.test.ts assert every field's round-trip error stays within half
 * its `quantStep`.
 */
import { WB } from '../world/depth.js';
import type { FieldSchema } from './schema.js';

export const MSG = {
  HELLO: 1,
  WELCOME: 2,
  REJECT: 3,
  INPUT: 4,
  PING: 5,
  PONG: 6,
  SNAPSHOT: 7,
  CORRECTION: 8,
  SERVER_RESTART: 9,
  AVATAR: 10,
  AVATARS: 11,
  PEER: 12,
} as const;

export type MsgId = (typeof MSG)[keyof typeof MSG];

export const Q = {
  X: { min: WB.x0 - 50, max: WB.x1 + 50, bits: 16 },
  Z: { min: WB.z0 - 50, max: WB.z1 + 50, bits: 16 },
  H: { min: -Math.PI, max: Math.PI, bits: 12 },
  // -10: small reverse-gear allowance; 65: hull-top * 1.35 scale * 1.12 envelope headroom
  // (fastest hull, MTI, tops out ~53 m/s) plus a wave-surge margin — see envelope.ts.
  SPEED: { min: -10, max: 65, bits: 12 },
  // A body's height: the deepest dive (~-60 m) to the highest roof deck in town.
  Y: { min: -80, max: 60, bits: 12 },
  // A body's speed, for the gait / fin-kick animation only: a sprint, or a hard kick.
  BODY_SPEED: { min: 0, max: 12, bits: 8 },
} as const;

/** What the player's body is doing off the boat. NONE = aboard (the boat is the player). */
export const AVATAR_MODE = { NONE: 0, WALK: 1, DIVE: 2 } as const;
/** Bytes of a display name in PEER: UTF-8, zero-padded (apps/api caps names well under this). */
export const PEER_NAME_BYTES = 32;

const boatEntryFields = [
  { kind: 'uint', name: 'slotId', bits: 9 },
  { kind: 'quant', name: 'x', bits: Q.X.bits, min: Q.X.min, max: Q.X.max },
  { kind: 'quant', name: 'z', bits: Q.Z.bits, min: Q.Z.min, max: Q.Z.max },
  { kind: 'quant', name: 'h', bits: Q.H.bits, min: Q.H.min, max: Q.H.max },
  { kind: 'quant', name: 'speed', bits: Q.SPEED.bits, min: Q.SPEED.min, max: Q.SPEED.max },
  { kind: 'bool', name: 'corrected' },
] as const satisfies readonly FieldSchema[];

const spawnEntryFields = [
  { kind: 'uint', name: 'slotId', bits: 9 },
  { kind: 'uint', name: 'hullIndex', bits: 3 },
  { kind: 'quant', name: 'x', bits: Q.X.bits, min: Q.X.min, max: Q.X.max },
  { kind: 'quant', name: 'z', bits: Q.Z.bits, min: Q.Z.min, max: Q.Z.max },
  { kind: 'quant', name: 'h', bits: Q.H.bits, min: Q.H.min, max: Q.H.max },
] as const satisfies readonly FieldSchema[];

const despawnEntryFields = [{ kind: 'uint', name: 'slotId', bits: 9 }] as const satisfies readonly FieldSchema[];

/** Client -> server, first message on a new connection. 32 raw bytes (the session token). */
export const HELLO_FIELDS = [{ kind: 'bytes', name: 'token', length: 32 }] as const satisfies readonly FieldSchema[];

/** Server -> client, on accepted auth. Carries the player's spawn/resume state up front. */
export const WELCOME_FIELDS = [
  { kind: 'uint', name: 'slotId', bits: 9 },
  { kind: 'uint', name: 'hullIndex', bits: 3 },
  { kind: 'uint', name: 'tick', bits: 32 },
  { kind: 'quant', name: 'x', bits: Q.X.bits, min: Q.X.min, max: Q.X.max },
  { kind: 'quant', name: 'z', bits: Q.Z.bits, min: Q.Z.min, max: Q.Z.max },
  { kind: 'quant', name: 'h', bits: Q.H.bits, min: Q.H.min, max: Q.H.max },
  { kind: 'quant', name: 'speed', bits: Q.SPEED.bits, min: Q.SPEED.min, max: Q.SPEED.max },
] as const satisfies readonly FieldSchema[];

/** Server -> client, on rejected auth (bad/expired/unknown token). Connection closes after. */
export const REJECT_FIELDS = [{ kind: 'uint', name: 'reason', bits: 8 }] as const satisfies readonly FieldSchema[];

/**
 * Client -> server, 30 Hz. Carries both the raw controls (for the server's shadow model) and the
 * client's own simulated x/z/h/speed (never y/pitch/roll — see docs/ARCHITECTURE.md's authority
 * table) for envelope validation, plus `ackTick`, the last SNAPSHOT tick this client has fully
 * applied.
 */
export const INPUT_FIELDS = [
  { kind: 'uint', name: 'seq', bits: 16 },
  { kind: 'uint', name: 'ackTick', bits: 32 },
  { kind: 'bool', name: 'fwd' },
  { kind: 'bool', name: 'back' },
  { kind: 'bool', name: 'left' },
  { kind: 'bool', name: 'right' },
  { kind: 'bool', name: 'trimUp' },
  { kind: 'bool', name: 'trimDn' },
  { kind: 'quant', name: 'x', bits: Q.X.bits, min: Q.X.min, max: Q.X.max },
  { kind: 'quant', name: 'z', bits: Q.Z.bits, min: Q.Z.min, max: Q.Z.max },
  { kind: 'quant', name: 'h', bits: Q.H.bits, min: Q.H.min, max: Q.H.max },
  { kind: 'quant', name: 'speed', bits: Q.SPEED.bits, min: Q.SPEED.min, max: Q.SPEED.max },
] as const satisfies readonly FieldSchema[];

export const PING_FIELDS = [{ kind: 'uint', name: 'clientTimeMs', bits: 32 }] as const satisfies readonly FieldSchema[];

export const PONG_FIELDS = [
  { kind: 'uint', name: 'clientTimeMs', bits: 32 },
  { kind: 'uint', name: 'serverTimeMs', bits: 32 },
] as const satisfies readonly FieldSchema[];

/**
 * Server -> client, 15 Hz, per-player filtered by the interest grid (interest.ts). `spawns`/
 * `despawns` carry immutable descriptors once; `boats` carries this tick's absolute (not
 * delta-against-baseline — see apps/sim's README note / the Phase 2 report) quantized state.
 */
export const SNAPSHOT_FIELDS = [
  { kind: 'uint', name: 'tick', bits: 32 },
  { kind: 'array', name: 'spawns', countBits: 8, maxCount: 255, element: spawnEntryFields },
  { kind: 'array', name: 'despawns', countBits: 8, maxCount: 255, element: despawnEntryFields },
  { kind: 'array', name: 'boats', countBits: 9, maxCount: 511, element: boatEntryFields },
] as const satisfies readonly FieldSchema[];

/**
 * Server -> client, only to the owning connection, only on a hard-leash/envelope violation.
 * Fields are exactly x/z/h/speed — structurally incapable of touching y/pitch/roll, which is
 * what docs/ARCHITECTURE.md's "corrections only ever write x, z, h, speed" requires.
 */
export const CORRECTION_FIELDS = [
  { kind: 'quant', name: 'x', bits: Q.X.bits, min: Q.X.min, max: Q.X.max },
  { kind: 'quant', name: 'z', bits: Q.Z.bits, min: Q.Z.min, max: Q.Z.max },
  { kind: 'quant', name: 'h', bits: Q.H.bits, min: Q.H.min, max: Q.H.max },
  { kind: 'quant', name: 'speed', bits: Q.SPEED.bits, min: Q.SPEED.min, max: Q.SPEED.max },
] as const satisfies readonly FieldSchema[];

export const SERVER_RESTART_FIELDS = [{ kind: 'uint', name: 'etaMs', bits: 32 }] as const satisfies readonly FieldSchema[];

const bodyFields = [
  { kind: 'uint', name: 'mode', bits: 2 },
  { kind: 'quant', name: 'x', bits: Q.X.bits, min: Q.X.min, max: Q.X.max },
  { kind: 'quant', name: 'z', bits: Q.Z.bits, min: Q.Z.min, max: Q.Z.max },
  { kind: 'quant', name: 'y', bits: Q.Y.bits, min: Q.Y.min, max: Q.Y.max },
  { kind: 'quant', name: 'h', bits: Q.H.bits, min: Q.H.min, max: Q.H.max },
  { kind: 'quant', name: 'speed', bits: Q.BODY_SPEED.bits, min: Q.BODY_SPEED.min, max: Q.BODY_SPEED.max },
] as const satisfies readonly FieldSchema[];

/**
 * Client -> server, ~10 Hz while the player is off the boat (and once with mode NONE on climbing
 * back aboard): where their body is. Cosmetic, so it is the client's word — the sim only relays it
 * to nearby players; the boat stays the envelope-checked entity.
 */
export const AVATAR_FIELDS = bodyFields;

/** Server -> client, with every SNAPSHOT: the bodies of nearby players who are off their boats.
 * A slot missing from the list has no body out (it is aboard, or out of range). */
export const AVATARS_FIELDS = [
  { kind: 'array', name: 'bodies', countBits: 6, maxCount: 63, element: [{ kind: 'uint', name: 'slotId', bits: 9 }, ...bodyFields] },
] as const satisfies readonly FieldSchema[];

/** Server -> client: who a slot is, so nametags carry names. Sent for everyone online on WELCOME,
 * then for each player who joins. */
export const PEER_FIELDS = [
  { kind: 'uint', name: 'slotId', bits: 9 },
  { kind: 'bytes', name: 'name', length: PEER_NAME_BYTES },
] as const satisfies readonly FieldSchema[];

/** Registry used by the generic dispatcher (apps/sim) to go from a wire id to its fields table. */
export const MESSAGES = {
  [MSG.HELLO]: { name: 'HELLO', fields: HELLO_FIELDS },
  [MSG.WELCOME]: { name: 'WELCOME', fields: WELCOME_FIELDS },
  [MSG.REJECT]: { name: 'REJECT', fields: REJECT_FIELDS },
  [MSG.INPUT]: { name: 'INPUT', fields: INPUT_FIELDS },
  [MSG.PING]: { name: 'PING', fields: PING_FIELDS },
  [MSG.PONG]: { name: 'PONG', fields: PONG_FIELDS },
  [MSG.SNAPSHOT]: { name: 'SNAPSHOT', fields: SNAPSHOT_FIELDS },
  [MSG.CORRECTION]: { name: 'CORRECTION', fields: CORRECTION_FIELDS },
  [MSG.SERVER_RESTART]: { name: 'SERVER_RESTART', fields: SERVER_RESTART_FIELDS },
  [MSG.AVATAR]: { name: 'AVATAR', fields: AVATAR_FIELDS },
  [MSG.AVATARS]: { name: 'AVATARS', fields: AVATARS_FIELDS },
  [MSG.PEER]: { name: 'PEER', fields: PEER_FIELDS },
} as const;

export type HelloMsg = import('./schema.js').InferFields<typeof HELLO_FIELDS>;
export type WelcomeMsg = import('./schema.js').InferFields<typeof WELCOME_FIELDS>;
export type RejectMsg = import('./schema.js').InferFields<typeof REJECT_FIELDS>;
export type InputMsg = import('./schema.js').InferFields<typeof INPUT_FIELDS>;
export type PingMsg = import('./schema.js').InferFields<typeof PING_FIELDS>;
export type PongMsg = import('./schema.js').InferFields<typeof PONG_FIELDS>;
export type SnapshotMsg = import('./schema.js').InferFields<typeof SNAPSHOT_FIELDS>;
export type CorrectionMsg = import('./schema.js').InferFields<typeof CORRECTION_FIELDS>;
export type ServerRestartMsg = import('./schema.js').InferFields<typeof SERVER_RESTART_FIELDS>;
export type AvatarMsg = import('./schema.js').InferFields<typeof AVATAR_FIELDS>;
export type AvatarsMsg = import('./schema.js').InferFields<typeof AVATARS_FIELDS>;
export type PeerMsg = import('./schema.js').InferFields<typeof PEER_FIELDS>;

/** A display name as PEER carries it, and back: UTF-8 (by hand — this package has no DOM or Node
 * lib), zero-padded, truncated on a character boundary. */
export function encodePeerName(name: string): Uint8Array {
  const out = new Uint8Array(PEER_NAME_BYTES);
  let n = 0;
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0x3f;
    const b = c < 0x80 ? [c]
      : c < 0x800 ? [0xc0 | (c >> 6), 0x80 | (c & 63)]
        : c < 0x10000 ? [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)]
          : [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)];
    if (n + b.length > PEER_NAME_BYTES) break;
    for (const x of b) out[n++] = x;
  }
  return out;
}
export function decodePeerName(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length && bytes[i] !== 0;) {
    const b = bytes[i];
    const len = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    let c = len === 1 ? b : b & (0xff >> (len + 1));
    for (let k = 1; k < len; k++) c = (c << 6) | ((bytes[i + k] ?? 0) & 63);
    s += String.fromCodePoint(c);
    i += len;
  }
  return s;
}

/** Reject reason codes carried in `REJECT.reason`. */
export const RejectReason = {
  INVALID_TOKEN: 0,
  EXPIRED_TOKEN: 1,
  SERVER_FULL: 2,
} as const;
