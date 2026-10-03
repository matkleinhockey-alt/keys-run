/**
 * Thin per-message-type wrappers around the generic `encodeMessage` (packages/shared/src/proto).
 * One module-level `BitWriter` is reused (via `.reset(buffer)`) for every call — safe because
 * encoding is synchronous and single-threaded (Node), and every caller either sends/copies the
 * returned view immediately or has already done so before the next encode call.
 */
import { BitWriter, encodeMessage } from '@keysrun/shared/proto';
import {
  CORRECTION_FIELDS,
  MSG,
  PONG_FIELDS,
  REJECT_FIELDS,
  SERVER_RESTART_FIELDS,
  SNAPSHOT_FIELDS,
  WELCOME_FIELDS,
  type CorrectionMsg,
  type PongMsg,
  type RejectMsg,
  type ServerRestartMsg,
  type SnapshotMsg,
  type WelcomeMsg,
} from '@keysrun/shared/proto';

const sharedWriter = new BitWriter(new Uint8Array(0));

export function encodeWelcome(buf: Uint8Array, msg: WelcomeMsg): Uint8Array {
  sharedWriter.reset(buf);
  encodeMessage(MSG.WELCOME, WELCOME_FIELDS, msg, sharedWriter);
  return sharedWriter.finish();
}

export function encodeReject(buf: Uint8Array, msg: RejectMsg): Uint8Array {
  sharedWriter.reset(buf);
  encodeMessage(MSG.REJECT, REJECT_FIELDS, msg, sharedWriter);
  return sharedWriter.finish();
}

export function encodePong(buf: Uint8Array, msg: PongMsg): Uint8Array {
  sharedWriter.reset(buf);
  encodeMessage(MSG.PONG, PONG_FIELDS, msg, sharedWriter);
  return sharedWriter.finish();
}

export function encodeCorrection(buf: Uint8Array, msg: CorrectionMsg): Uint8Array {
  sharedWriter.reset(buf);
  encodeMessage(MSG.CORRECTION, CORRECTION_FIELDS, msg, sharedWriter);
  return sharedWriter.finish();
}

export function encodeServerRestart(buf: Uint8Array, msg: ServerRestartMsg): Uint8Array {
  sharedWriter.reset(buf);
  encodeMessage(MSG.SERVER_RESTART, SERVER_RESTART_FIELDS, msg, sharedWriter);
  return sharedWriter.finish();
}

export function encodeSnapshot(buf: Uint8Array, msg: SnapshotMsg): Uint8Array {
  sharedWriter.reset(buf);
  encodeMessage(MSG.SNAPSHOT, SNAPSHOT_FIELDS, msg, sharedWriter);
  return sharedWriter.finish();
}
