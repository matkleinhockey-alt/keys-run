/**
 * Client-side wire codec: thin wrappers around `@keysrun/shared/proto`'s schema-table-driven
 * BitWriter/BitReader, mirroring apps/sim/src/net/encode.ts and apps/sim/test/sim-client.ts (the
 * "reference client implementation" docs/ARCHITECTURE.md/the task brief point at) on the client
 * side of the same wire format. There is exactly one codec in this codebase
 * (packages/shared/src/proto) — nothing here hand-rolls a second encode/decode path.
 *
 * `HELLO_FIELDS.token` is 32 raw bytes; apps/api hands the client a 64-char hex session token
 * (apps/api/src/lib/auth.ts's `generateSessionToken`), so `tokenHexToBytes` is the one piece of
 * glue between "the token as apps/api gives it to us" and "the token as the wire format wants
 * it" — same conversion apps/sim/test/sim-client.ts's `sendHello` does server-side-test-client.
 */
import {
  BitReader,
  BitWriter,
  decodeMessageBody,
  encodeMessage,
  readMessageId,
  CORRECTION_FIELDS,
  HELLO_FIELDS,
  INPUT_FIELDS,
  MSG,
  PING_FIELDS,
  PONG_FIELDS,
  REJECT_FIELDS,
  SERVER_RESTART_FIELDS,
  SNAPSHOT_FIELDS,
  WELCOME_FIELDS,
  type CorrectionMsg,
  type InputMsg,
  type PongMsg,
  type RejectMsg,
  type ServerRestartMsg,
  type SnapshotMsg,
  type WelcomeMsg,
} from '@keysrun/shared/proto';

/** 64-char hex (apps/api's `generateSessionToken`) -> 32 raw bytes (`HELLO_FIELDS.token`). */
export function tokenHexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('tokenHexToBytes: expected 64 hex chars');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const SCRATCH_SIZE = 8192;

/** One reusable scratch buffer for outbound encodes — safe because sends are synchronous and
 * each caller copies/transmits the returned view before the next encode call (same pattern as
 * apps/sim/src/net/encode.ts's module-level `sharedWriter`). */
const scratch = new Uint8Array(SCRATCH_SIZE);
const writer = new BitWriter(scratch);

export function encodeHello(tokenHex: string): Uint8Array {
  writer.reset(scratch);
  encodeMessage(MSG.HELLO, HELLO_FIELDS, { token: tokenHexToBytes(tokenHex) }, writer);
  return writer.finish().slice();
}

export function encodeInput(msg: InputMsg): Uint8Array {
  writer.reset(scratch);
  encodeMessage(MSG.INPUT, INPUT_FIELDS, msg, writer);
  return writer.finish().slice();
}

export function encodePing(clientTimeMs: number): Uint8Array {
  writer.reset(scratch);
  encodeMessage(MSG.PING, PING_FIELDS, { clientTimeMs }, writer);
  return writer.finish().slice();
}

export type ServerMessage =
  | { type: 'welcome'; msg: WelcomeMsg }
  | { type: 'reject'; msg: RejectMsg }
  | { type: 'snapshot'; msg: SnapshotMsg; byteLength: number }
  | { type: 'correction'; msg: CorrectionMsg }
  | { type: 'pong'; msg: PongMsg }
  | { type: 'server_restart'; msg: ServerRestartMsg }
  | { type: 'unknown'; id: number };

/** Decode one inbound binary frame. Pure function — no socket/transport knowledge. */
export function decodeServerMessage(bytes: Uint8Array): ServerMessage {
  const reader = new BitReader(bytes);
  const id = readMessageId(reader);
  switch (id) {
    case MSG.WELCOME:
      return { type: 'welcome', msg: decodeMessageBody(WELCOME_FIELDS, reader) };
    case MSG.REJECT:
      return { type: 'reject', msg: decodeMessageBody(REJECT_FIELDS, reader) };
    case MSG.SNAPSHOT:
      return { type: 'snapshot', msg: decodeMessageBody(SNAPSHOT_FIELDS, reader), byteLength: bytes.length };
    case MSG.CORRECTION:
      return { type: 'correction', msg: decodeMessageBody(CORRECTION_FIELDS, reader) };
    case MSG.PONG:
      return { type: 'pong', msg: decodeMessageBody(PONG_FIELDS, reader) };
    case MSG.SERVER_RESTART:
      return { type: 'server_restart', msg: decodeMessageBody(SERVER_RESTART_FIELDS, reader) };
    default:
      return { type: 'unknown', id };
  }
}

export { RejectReason } from '@keysrun/shared/proto';
