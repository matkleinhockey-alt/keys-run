/**
 * Raw `ws` implementation of the Transport interface. `perMessageDeflate: false` (compressing
 * 400-byte frames 15x/s is a CPU fire — docs/ARCHITECTURE.md) and `noDelay: true` on the
 * underlying TCP socket (via the upgrade request's socket — `ws` doesn't expose a public
 * setter). Attaches to an existing `http.Server` so one port serves both the WS upgrade and
 * /health, /metrics (see http.ts, index.ts).
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Transport, TransportConnection } from './transport.js';

function wrapWebSocket(ws: WebSocket): TransportConnection {
  let msgHandler: ((bytes: Uint8Array) => void) | null = null;
  let closeHandler: ((code: number, reason: string) => void) | null = null;

  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (!isBinary || !msgHandler) return;
    if (Array.isArray(data)) return; // fragmented messages disabled by default in ws; ignore defensively
    const bytes = Buffer.isBuffer(data) ? new Uint8Array(data.buffer, data.byteOffset, data.length) : new Uint8Array(data);
    msgHandler(bytes);
  });

  ws.on('close', (code: number, reasonBuf: Buffer) => {
    closeHandler?.(code, reasonBuf.toString('utf8'));
  });

  ws.on('error', () => {
    // Swallow — 'close' always follows an 'error' for ws, which is where we clean up.
  });

  return {
    id: randomUUID(),
    // `bytes` is typically a zero-copy view into a reused scratch buffer (see net/encode.ts) —
    // copy here, once, in the one place that knows whether `ws` itself would retain the
    // reference past this synchronous call (it may, e.g. under socket backpressure). This is
    // the one deliberate allocation in the send path; see the Phase 2 handoff report's
    // "zero allocation" discussion for why it's here and not avoided.
    send: (bytes: Uint8Array) => {
      if (ws.readyState === ws.OPEN) ws.send(Buffer.from(bytes));
    },
    close: (code: number, reason = '') => {
      try {
        ws.close(code, reason);
      } catch {
        // already closing/closed
      }
    },
    onMessage: (handler) => {
      msgHandler = handler;
    },
    onClose: (handler) => {
      closeHandler = handler;
    },
  };
}

export class WsTransport implements Transport {
  private wss: WebSocketServer;
  private connectionHandler: ((conn: TransportConnection) => void) | null = null;

  constructor(httpServer: Server) {
    this.wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false });
    this.wss.on('connection', (ws, req) => {
      req.socket.setNoDelay(true);
      this.connectionHandler?.(wrapWebSocket(ws));
    });
  }

  onConnection(handler: (conn: TransportConnection) => void): void {
    this.connectionHandler = handler;
  }

  /** Every open connection, for broadcast (SERVER_RESTART) and graceful-close purposes. */
  get clients(): Set<WebSocket> {
    return this.wss.clients;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}
