/**
 * Transport abstraction — docs/ARCHITECTURE.md: "Keep a `Transport` interface so that [moving
 * off Railway to raw UDP later] stays a one-file change." Everything above this layer
 * (dispatch.ts, World) speaks in `TransportConnection`/byte arrays only, never `ws` directly.
 */
export interface TransportConnection {
  readonly id: string;
  send(bytes: Uint8Array): void;
  close(code: number, reason?: string): void;
  onMessage(handler: (bytes: Uint8Array) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
}

export interface Transport {
  onConnection(handler: (conn: TransportConnection) => void): void;
  stop(): Promise<void>;
}
