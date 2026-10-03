/**
 * The message table: every wire message Keys Run's `sim` service sends or receives, as one
 * `FieldSchema[]` per type (see schema.ts/codec.ts for why that's the whole codec). Scope is
 * Phase 2 — boat replication only; rod fishing (CAST/STRIKE/CATCH) and diver/spear messages are
 * later phases and deliberately absent.
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
} as const;

export type MsgId = (typeof MSG)[keyof typeof MSG];

export const Q = {
  X: { min: WB.x0 - 50, max: WB.x1 + 50, bits: 16 },
  Z: { min: WB.z0 - 50, max: WB.z1 + 50, bits: 16 },
  H: { min: -Math.PI, max: Math.PI, bits: 12 },
  // -10: small reverse-gear allowance; 65: hull-top * 1.35 scale * 1.12 envelope headroom
  // (fastest hull, MTI, tops out ~53 m/s) plus a wave-surge margin — see envelope.ts.
  SPEED: { min: -10, max: 65, bits: 12 },
} as const;

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

/** Reject reason codes carried in `REJECT.reason`. */
export const RejectReason = {
  INVALID_TOKEN: 0,
  EXPIRED_TOKEN: 1,
  SERVER_FULL: 2,
} as const;
