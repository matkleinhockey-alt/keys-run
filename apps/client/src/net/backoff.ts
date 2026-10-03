/**
 * Reconnect backoff schedule — docs/ARCHITECTURE.md's "Reconnect-and-resume": "exponential
 * backoff + jitter, retry forever", and the task brief's explicit sequence: 0.5, 1, 2, 4, 8 s,
 * capped at 10 s, retrying forever (never giving up).
 *
 * Pure function, no timers: `nextDelayMs(attempt)` returns the *base* delay for a given 0-based
 * retry attempt, and `withJitter` adds +/-50% multiplicative jitter (so N simultaneously-
 * disconnected clients — e.g. everyone, right after a `sim` deploy — don't all reconnect in the
 * same instant and thunder the herd). `attempt` is clamped to the schedule's last step, which is
 * what makes "retry forever" true: `attempt` can grow without bound and the delay just stays at
 * the 10 s cap instead of overflowing.
 */

export const BASE_SCHEDULE_MS = [500, 1000, 2000, 4000, 8000] as const;
export const MAX_DELAY_MS = 10_000;

/** Base delay (no jitter) for the given 0-based attempt number. Never exceeds `MAX_DELAY_MS`. */
export function nextDelayMs(attempt: number): number {
  const i = Math.max(0, Math.min(attempt, BASE_SCHEDULE_MS.length - 1));
  return Math.min(BASE_SCHEDULE_MS[i], MAX_DELAY_MS);
}

/**
 * +/-50% multiplicative jitter around the base delay, floored at 50 ms so a jittered-down 0.5 s
 * step can never round to "retry immediately". `rand` is injectable (defaults to `Math.random`)
 * so this is deterministically testable.
 */
export function withJitter(baseMs: number, rand: () => number = Math.random): number {
  const jitterFactor = 0.5 + rand(); // [0.5, 1.5)
  return Math.max(50, Math.round(baseMs * jitterFactor));
}

/** Convenience: the jittered delay to wait before the given 0-based attempt. */
export function backoffDelayMs(attempt: number, rand: () => number = Math.random): number {
  return withJitter(nextDelayMs(attempt), rand);
}
