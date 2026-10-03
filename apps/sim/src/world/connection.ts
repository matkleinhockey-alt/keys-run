/**
 * Per-connection bookkeeping. Allocated once at connect time (not in the steady-state tick) and
 * mutated in place thereafter — `pendingInput`'s control/report fields are overwritten field-by-
 * field on every INPUT message rather than replacing the object, so receiving input allocates
 * nothing either.
 *
 * `send` is a plain callback, not a `ws`/socket reference — this is what lets `World` (world.ts)
 * stay transport-agnostic and unit-testable without a real socket; `net/dispatch.ts` is the only
 * place that wires a real `TransportConnection` in.
 */
import type { SubscriptionInfo } from './interest.js';

export interface MutableInput {
  seq: number;
  ackTick: number;
  fwd: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  trimUp: boolean;
  trimDn: boolean;
  /** Client's self-simulated x/z/h/speed this tick — see docs/ARCHITECTURE.md's authority table. */
  x: number;
  z: number;
  h: number;
  speed: number;
}

export interface ConnMeta {
  slot: number;
  userId: string;
  send: (bytes: Uint8Array) => void;

  input: MutableInput;
  /** True if `input` has been written since the last tick consumed it. */
  hasNewInput: boolean;

  ackTick: number;
  subscriptions: Map<number, SubscriptionInfo>;
  scratchCandidates: Set<number>;
  enteredSinceSnapshot: number[];
  leftSinceSnapshot: number[];

  connectedAtMs: number;
  lastInputAtMs: number;
  dirty: boolean;
}

export function createConnMeta(slot: number, userId: string, send: (bytes: Uint8Array) => void, nowMs: number): ConnMeta {
  return {
    slot,
    userId,
    send,
    input: {
      seq: 0,
      ackTick: 0,
      fwd: false,
      back: false,
      left: false,
      right: false,
      trimUp: false,
      trimDn: false,
      x: 0,
      z: 0,
      h: 0,
      speed: 0,
    },
    hasNewInput: false,
    ackTick: 0,
    subscriptions: new Map(),
    scratchCandidates: new Set(),
    enteredSinceSnapshot: [],
    leftSinceSnapshot: [],
    connectedAtMs: nowMs,
    lastInputAtMs: nowMs,
    dirty: true,
  };
}

/** Copy an `InputMsg`-shaped decoded message into `target.input` in place — zero allocation. */
export function applyInputMessage(
  target: ConnMeta,
  msg: {
    seq: number;
    ackTick: number;
    fwd: boolean;
    back: boolean;
    left: boolean;
    right: boolean;
    trimUp: boolean;
    trimDn: boolean;
    x: number;
    z: number;
    h: number;
    speed: number;
  },
  nowMs: number,
): void {
  const i = target.input;
  i.seq = msg.seq;
  i.ackTick = msg.ackTick;
  i.fwd = msg.fwd;
  i.back = msg.back;
  i.left = msg.left;
  i.right = msg.right;
  i.trimUp = msg.trimUp;
  i.trimDn = msg.trimDn;
  i.x = msg.x;
  i.z = msg.z;
  i.h = msg.h;
  i.speed = msg.speed;
  target.hasNewInput = true;
  target.ackTick = msg.ackTick;
  target.lastInputAtMs = nowMs;
}
