/**
 * A minimal synthetic wire-protocol client, shared by lifecycle.test.ts and load.ts. Talks the
 * real binary protocol (packages/shared/src/proto) over a real `ws` connection — this is
 * deliberately not a mock of World/dispatch, so a passing test here is evidence the actual wire
 * format round-trips end to end, not just that the in-process modules agree with each other.
 */
import WebSocket from 'ws';
import { BitReader, BitWriter, decodeMessageBody, encodeMessage, readMessageId } from '@keysrun/shared/proto';
import {
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

export interface SimClientHandlers {
  onWelcome?: (msg: WelcomeMsg) => void;
  onSnapshot?: (msg: SnapshotMsg, byteLength: number) => void;
  onCorrection?: (msg: CorrectionMsg) => void;
  onReject?: (msg: RejectMsg) => void;
  onPong?: (msg: PongMsg) => void;
  onServerRestart?: (msg: ServerRestartMsg) => void;
  onClose?: (code: number, reason: string) => void;
}

const SCRATCH_SIZE = 8192;

export class SimTestClient {
  readonly ws: WebSocket;
  private scratch = new Uint8Array(SCRATCH_SIZE);

  constructor(url: string, handlers: SimClientHandlers = {}) {
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.length);
      const reader = new BitReader(bytes);
      const id = readMessageId(reader);
      switch (id) {
        case MSG.WELCOME:
          handlers.onWelcome?.(decodeMessageBody(WELCOME_FIELDS, reader));
          break;
        case MSG.SNAPSHOT:
          handlers.onSnapshot?.(decodeMessageBody(SNAPSHOT_FIELDS, reader), bytes.length);
          break;
        case MSG.CORRECTION:
          handlers.onCorrection?.(decodeMessageBody(CORRECTION_FIELDS, reader));
          break;
        case MSG.REJECT:
          handlers.onReject?.(decodeMessageBody(REJECT_FIELDS, reader));
          break;
        case MSG.PONG:
          handlers.onPong?.(decodeMessageBody(PONG_FIELDS, reader));
          break;
        case MSG.SERVER_RESTART:
          handlers.onServerRestart?.(decodeMessageBody(SERVER_RESTART_FIELDS, reader));
          break;
      }
    });
    this.ws.on('close', (code: number, reason: Buffer) => handlers.onClose?.(code, reason.toString('utf8')));
  }

  waitOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  sendHello(tokenHex: string): void {
    const tokenBytes = new Uint8Array(Buffer.from(tokenHex, 'hex'));
    const writer = new BitWriter(this.scratch);
    encodeMessage(MSG.HELLO, HELLO_FIELDS, { token: tokenBytes }, writer);
    this.ws.send(Buffer.from(writer.finish()));
  }

  sendInput(msg: InputMsg): void {
    const writer = new BitWriter(this.scratch);
    encodeMessage(MSG.INPUT, INPUT_FIELDS, msg, writer);
    this.ws.send(Buffer.from(writer.finish()));
  }

  sendPing(clientTimeMs: number): void {
    const writer = new BitWriter(this.scratch);
    encodeMessage(MSG.PING, PING_FIELDS, { clientTimeMs }, writer);
    this.ws.send(Buffer.from(writer.finish()));
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
}
