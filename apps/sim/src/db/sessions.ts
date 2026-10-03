/**
 * Read-only session validation against the `sessions` table apps/api/src/db/schema.ts owns.
 * Mirrors apps/api/src/lib/sessions.ts's `resolveSession` logic exactly (well-formed check,
 * hash, constant-time compare, revoked/expired checks) but never writes — `sim` only ever
 * reads `sessions`; creating/revoking sessions is exclusively `api`'s job (login/logout).
 */
import type { Pool } from 'pg';
import { constantTimeEqualHex, hashSessionToken, isWellFormedToken } from '../auth/session-token.js';

export interface ResolvedSession {
  userId: string;
}

export async function resolveSessionToken(pool: Pool, presentedToken: string): Promise<ResolvedSession | null> {
  if (!isWellFormedToken(presentedToken)) return null;
  const tokenHash = hashSessionToken(presentedToken);
  const result = await pool.query<{ user_id: string; token_hash: string; expires_at: Date; revoked_at: Date | null }>(
    'SELECT user_id, token_hash, expires_at, revoked_at FROM sessions WHERE token_hash = $1 LIMIT 1',
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (!constantTimeEqualHex(row.token_hash, tokenHash)) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return { userId: row.user_id };
}
