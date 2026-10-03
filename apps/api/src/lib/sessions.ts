import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { generateSessionToken, hashSessionToken, constantTimeEqualHex, SESSION_TTL_MS } from './auth.js';

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

export async function createSession(db: Db, userId: string): Promise<CreatedSession> {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ userId, tokenHash, expiresAt });
  return { token, expiresAt };
}

/**
 * Looks up the session for a presented token. Returns the userId if the
 * token is well-formed, matches a stored hash (constant-time comparison,
 * not bare SQL/string equality), is not revoked, and has not expired.
 */
export async function resolveSession(db: Db, presentedToken: string): Promise<{ userId: string } | null> {
  if (!/^[0-9a-f]{64}$/i.test(presentedToken)) return null;
  const tokenHash = hashSessionToken(presentedToken);
  const rows = await db
    .select({ userId: sessions.userId, tokenHash: sessions.tokenHash, expiresAt: sessions.expiresAt, revokedAt: sessions.revokedAt })
    .from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (!constantTimeEqualHex(row.tokenHash, tokenHash)) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return { userId: row.userId };
}

export async function revokeSession(db: Db, presentedToken: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/i.test(presentedToken)) return;
  const tokenHash = hashSessionToken(presentedToken);
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
}
