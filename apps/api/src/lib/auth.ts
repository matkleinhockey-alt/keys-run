/**
 * Password hashing and session token primitives.
 *
 * argon2id lives here, in `api`, and must never be imported from `sim` — see
 * docs/ARCHITECTURE.md "argon2id takes 50-100ms, which would eat three
 * [30 Hz] ticks". The params below land in that range on typical hardware;
 * that cost is the point, not a bug to tune away.
 *
 * Session tokens are opaque random bytes, never JWTs (docs/ARCHITECTURE.md
 * task brief). The raw token is handed to the client once, at login; only
 * sha256(token) is ever persisted, and comparisons against a stored hash use
 * crypto.timingSafeEqual rather than string/SQL equality.
 */
import argon2 from 'argon2';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  // ~50-100ms target on typical server hardware: 19 MiB memory, 2 iterations,
  // 1 degree of parallelism is argon2's own RFC 9106 "low memory" baseline;
  // we go a bit heavier on memory since this process never touches the 30 Hz
  // tick loop and has no latency budget to protect.
  memoryCost: 2 ** 16, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // Malformed hash, algorithm mismatch, etc. — treat as "does not match"
    // rather than letting the error escape and leak information via timing
    // or a 500.
    return false;
  }
}

const SESSION_TOKEN_BYTES = 32;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** 32 random bytes, hex-encoded (64 chars). This is the opaque token handed to the client. */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('hex');
}

/** sha256(token), hex-encoded — what actually gets stored in sessions.token_hash. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two hex-encoded hashes. Used instead of trusting
 * the database's equality filter alone when validating a presented session
 * token against the stored hash it fetched.
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
