/**
 * `NetClient`: the WebSocket connection to `apps/sim`, talking the real binary protocol
 * (packages/shared/src/proto) the same way apps/sim/test/sim-client.ts's synthetic client does —
 * HELLO with the session token -> WELCOME/REJECT -> INPUT/PING while connected, SNAPSHOT/
 * CORRECTION/SERVER_RESTART inbound.
 *
 * Three behaviours docs/ARCHITECTURE.md requires live here, all in one place because they
 * interact (a reconnect must not discard remote-boat tracking the way a real disconnect would,
 * and the input timer must survive a reconnect without drifting):
 *
 *  1. **Timer-accumulator input send, not rAF** ("backgrounded tabs stop rAF" — docs/
 *     ARCHITECTURE.md's netcode table). `setLocalState()` is cheap and called every rendered
 *     frame by main.ts; a `setInterval` fires independently at 30 Hz and sends whatever the most
 *     recent `setLocalState()` call left behind, so input keeps flowing even if rAF is throttled.
 *  2. **Reconnect with exponential backoff + jitter, forever** (net/backoff.ts), *without* ever
 *     clearing `tracks` — a dropped connection freezes remote boats in place (their extrapolation
 *     naturally stops advancing past `MAX_EXTRAPOLATION_MS`, see extrapolate.ts) rather than
 *     despawning them, which is what makes "the client keeps rendering throughout... and
 *     resumes" (the reconnect-and-resume section) true with no special-case code on resume: the
 *     next SNAPSHOT after reconnecting just updates the same tracks back to life.
 *  3. **Byte-rate measurement** (task brief's "Measure: bytes/sec observed client-side") via a
 *     simple rolling 1 s window over inbound frame sizes.
 */
import {
  decodeServerMessage,
  encodeHello,
  encodeInput,
  encodePing,
  RejectReason,
} from './protocol.js';
import { backoffDelayMs } from './backoff.js';
import { createTrack, pushSample, poseAt, type RemoteBoatTrack, type BoatPose } from './extrapolate.js';
import { createReconciler } from './reconcile.js';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'auth_failed' | 'closed';

export interface LocalBoatInput {
  x: number;
  z: number;
  h: number;
  speed: number;
  fwd: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  trimUp: boolean;
  trimDn: boolean;
}

export interface RemoteBoatSnapshot {
  slotId: number;
  hullIndex: number;
  pose: BoatPose;
  /** 0..1 spawn fade-in (0.4 s — docs/ARCHITECTURE.md's "No popping" / the task brief). */
  fade: number;
}

export interface NetClientEvents {
  onConnectionState?(state: ConnectionState, detail?: { attempt?: number; nextRetryMs?: number; reason?: string }): void;
  onWelcome?(w: { slotId: number; hullIndex: number; x: number; z: number; h: number; speed: number }): void;
  onSpawn?(e: { slotId: number; hullIndex: number }): void;
  onDespawn?(slotId: number): void;
  onServerRestart?(etaMs: number): void;
}

export interface NetClientOptions {
  wsUrl: string;
  tokenHex: string;
  events?: NetClientEvents;
}

const INPUT_HZ = 30;
const PING_INTERVAL_MS = 2000;
const SPAWN_FADE_MS = 400;

export class NetClient {
  private ws: WebSocket | null = null;
  private opts: NetClientOptions;
  private state: ConnectionState = 'closed';
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private inputTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private welcomed = false;

  private localSlotId: number | null = null;
  private seq = 0;
  private lastAppliedTick = 0;
  private latestLocalState: LocalBoatInput | null = null;

  private tracks = new Map<number, RemoteBoatTrack>();
  private reconciler = createReconciler();

  private rttMs: number | null = null;
  private pingSentAtMs = new Map<number, number>();

  // Rolling 1s byte-rate window: timestamps bucketed to the second.
  private byteBuckets = new Map<number, number>();

  constructor(opts: NetClientOptions) {
    this.opts = opts;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  getLatencyMs(): number | null {
    return this.rttMs;
  }

  getPresenceCount(): number {
    return this.tracks.size;
  }

  getBytesPerSec(): number {
    const nowSec = Math.floor(performance.now() / 1000);
    // Sum the last 2 full seconds (excluding the current, still-filling one) for stability.
    let sum = 0, n = 0;
    for (let s = nowSec - 2; s < nowSec; s++) {
      const v = this.byteBuckets.get(s);
      if (v !== undefined) { sum += v; n++; }
    }
    return n > 0 ? sum / n : 0;
  }

  /** Called every render frame (cheap: just copies numbers for the 30 Hz input timer to pick up). */
  setLocalState(input: LocalBoatInput): void {
    this.latestLocalState = input;
  }

  /**
   * Called every render frame. Advances the reconciler (if a correction is in flight) and
   * returns the pose `World.applyNetCorrection` should write this frame, or `null` if there is
   * nothing to apply right now (either no correction pending, or it just settled).
   */
  consumeCorrection(dt: number): BoatPose | null {
    if (!this.reconciler.active()) return null;
    return this.reconciler.step(dt);
  }

  /** Extrapolated poses for every currently-tracked remote boat, for remote-boats.ts to render. */
  getRemoteBoats(nowMs: number): RemoteBoatSnapshot[] {
    const out: RemoteBoatSnapshot[] = [];
    for (const track of this.tracks.values()) {
      const fade = Math.max(0, Math.min(1, (nowMs - track.spawnedAtMs) / SPAWN_FADE_MS));
      out.push({ slotId: track.slotId, hullIndex: track.hullIndex, pose: poseAt(track, nowMs), fade });
    }
    return out;
  }

  connect(): void {
    if (this.destroyed) return;
    this.openSocket();
  }

  /** Explicit, user-initiated disconnect (e.g. logout) — stops the retry loop entirely. */
  disconnect(): void {
    this.destroyed = true;
    this.teardownSocket();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.inputTimer) clearInterval(this.inputTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.setState('closed');
  }

  private setState(state: ConnectionState, detail?: { attempt?: number; nextRetryMs?: number; reason?: string }): void {
    this.state = state;
    this.opts.events?.onConnectionState?.(state, detail);
  }

  private openSocket(): void {
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting', { attempt: this.attempt });
    this.welcomed = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.wsUrl);
    } catch {
      this.scheduleReconnect('construct-failed');
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      ws.send(encodeHello(this.opts.tokenHex));
    });

    ws.addEventListener('message', (ev) => {
      if (this.ws !== ws) return;
      if (!(ev.data instanceof ArrayBuffer)) return;
      this.recordBytes(ev.data.byteLength);
      this.handleMessage(new Uint8Array(ev.data));
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPerConnectionTimers();
      if (this.destroyed) return;
      this.scheduleReconnect('closed');
    });

    ws.addEventListener('error', () => {
      // 'close' always follows 'error' for a browser WebSocket; the close handler does the work.
    });
  }

  private scheduleReconnect(reason: string): void {
    if (this.destroyed) return;
    const delay = backoffDelayMs(this.attempt);
    this.attempt++;
    this.setState('reconnecting', { attempt: this.attempt, nextRetryMs: delay, reason });
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
  }

  private teardownSocket(): void {
    this.stopPerConnectionTimers();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try { ws.close(); } catch { /* already closing */ }
    }
  }

  private stopPerConnectionTimers(): void {
    if (this.inputTimer) { clearInterval(this.inputTimer); this.inputTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private startPerConnectionTimers(): void {
    this.inputTimer = setInterval(() => this.sendInput(), 1000 / INPUT_HZ);
    this.pingTimer = setInterval(() => this.sendPing(), PING_INTERVAL_MS);
  }

  private sendInput(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.welcomed) return;
    const s = this.latestLocalState;
    if (!s) return;
    this.ws.send(
      encodeInput({
        seq: (this.seq = (this.seq + 1) & 0xffff),
        ackTick: this.lastAppliedTick,
        fwd: s.fwd, back: s.back, left: s.left, right: s.right, trimUp: s.trimUp, trimDn: s.trimDn,
        x: s.x, z: s.z, h: s.h, speed: s.speed,
      }),
    );
  }

  private sendPing(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const t = Math.floor(performance.now()) >>> 0;
    this.pingSentAtMs.set(t, performance.now());
    if (this.pingSentAtMs.size > 8) {
      // Bounded: drop the oldest in-flight ping if PONGs are being lost.
      const oldest = this.pingSentAtMs.keys().next().value;
      if (oldest !== undefined) this.pingSentAtMs.delete(oldest);
    }
    this.ws.send(encodePing(t));
  }

  private recordBytes(n: number): void {
    const sec = Math.floor(performance.now() / 1000);
    this.byteBuckets.set(sec, (this.byteBuckets.get(sec) ?? 0) + n);
    // Trim old buckets so this map never grows unbounded over a long session.
    if (this.byteBuckets.size > 8) {
      for (const k of this.byteBuckets.keys()) {
        if (k < sec - 4) this.byteBuckets.delete(k);
      }
    }
  }

  private handleMessage(bytes: Uint8Array): void {
    const decoded = decodeServerMessage(bytes);
    switch (decoded.type) {
      case 'welcome': {
        this.welcomed = true;
        this.attempt = 0;
        this.localSlotId = decoded.msg.slotId;
        this.lastAppliedTick = decoded.msg.tick;
        this.startPerConnectionTimers();
        this.setState('connected');
        this.opts.events?.onWelcome?.(decoded.msg);
        break;
      }
      case 'reject': {
        const fatal = decoded.msg.reason === RejectReason.INVALID_TOKEN || decoded.msg.reason === RejectReason.EXPIRED_TOKEN;
        if (fatal) {
          this.destroyed = true; // do not hammer the server with a token that will never work
          this.setState('auth_failed', { reason: String(decoded.msg.reason) });
        } else {
          this.scheduleReconnect('server-full');
        }
        break;
      }
      case 'snapshot': {
        this.lastAppliedTick = decoded.msg.tick;
        const nowMs = performance.now();
        const seen = new Set<number>();
        for (const sp of decoded.msg.spawns) {
          if (sp.slotId === this.localSlotId) continue;
          seen.add(sp.slotId);
          if (!this.tracks.has(sp.slotId)) {
            this.tracks.set(sp.slotId, createTrack(sp.slotId, sp.hullIndex, { x: sp.x, z: sp.z, h: sp.h, speed: 0, receivedAtMs: nowMs }));
            this.opts.events?.onSpawn?.({ slotId: sp.slotId, hullIndex: sp.hullIndex });
          }
        }
        for (const b of decoded.msg.boats) {
          if (b.slotId === this.localSlotId) continue;
          let track = this.tracks.get(b.slotId);
          if (!track) {
            // A boat already in range before we subscribed can appear in `boats` without a prior
            // `spawns` entry in a race at subscription boundaries; synthesize a track rather than
            // drop the data (hullIndex defaults to 0 — cosmetic only, corrected on the next
            // despawn/spawn cycle).
            track = createTrack(b.slotId, 0, { x: b.x, z: b.z, h: b.h, speed: b.speed, receivedAtMs: nowMs });
            this.tracks.set(b.slotId, track);
            this.opts.events?.onSpawn?.({ slotId: b.slotId, hullIndex: 0 });
          } else {
            pushSample(track, { x: b.x, z: b.z, h: b.h, speed: b.speed, receivedAtMs: nowMs });
          }
          seen.add(b.slotId);
        }
        for (const d of decoded.msg.despawns) {
          if (this.tracks.delete(d.slotId)) this.opts.events?.onDespawn?.(d.slotId);
        }
        break;
      }
      case 'correction': {
        if (this.latestLocalState) {
          this.reconciler.setTarget(decoded.msg, { x: this.latestLocalState.x, z: this.latestLocalState.z, h: this.latestLocalState.h, speed: this.latestLocalState.speed });
        }
        break;
      }
      case 'pong': {
        const sentAt = this.pingSentAtMs.get(decoded.msg.clientTimeMs);
        if (sentAt !== undefined) {
          this.rttMs = performance.now() - sentAt;
          this.pingSentAtMs.delete(decoded.msg.clientTimeMs);
        }
        break;
      }
      case 'server_restart': {
        this.opts.events?.onServerRestart?.(decoded.msg.etaMs);
        break;
      }
      case 'unknown':
        break;
    }
  }
}
