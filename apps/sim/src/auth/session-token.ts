/**
 * Session token hashing/comparison — the non-password half of apps/api/src/lib/auth.ts,
 * duplicated deliberately rather than imported. `sim` must never import anything that could
 * transitively pull in `argon2` (docs/ARCHITECTURE.md: "argon2id takes 50-100ms, which would eat
 * three ticks — it must never run in `sim`"), and `apps/api` is not published as a shared
 * library (no package "exports"), so importing across the apps/api <-> apps/sim boundary would
 * be a deep relative import into another service's internals. This file must stay byte-for-byte
 * consistent with `hashSessionToken`/`constantTimeEqualHex` in apps/api/src/lib/auth.ts — both
 * hash sha256(token) hex and compare in constant time; if api's hashing ever changes, this must
 * change with it.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const SESSION_TOKEN_HEX_LENGTH = 64;

/** sha256(token), hex-encoded — must match apps/api/src/lib/auth.ts's hashSessionToken exactly. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** True if `token` is a well-formed 64-char hex session token (not whether it's valid/live). */
export function isWellFormedToken(token: string): boolean {
  return /^[0-9a-f]{64}$/i.test(token);
}
