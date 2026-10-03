/**
 * Shared test infra: a real Postgres handle (TEST_DATABASE_URL) plus a way to create a user +
 * live session row directly (sim has no registration endpoint of its own — it only ever reads
 * `sessions`/`players`, which `apps/api` owns; tests insert rows the same shape api's
 * registration would produce, with a placeholder password hash sim never checks).
 */
import '../src/env.js'; // side-effect: loads repo-root .env
import { randomBytes } from 'node:crypto';
import { createDb, type DbHandle } from '../src/db/pool.js';
import { hashSessionToken } from '../src/auth/session-token.js';

export function testDbHandle(): DbHandle {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set — see .env.example');
  return createDb(url);
}

const TABLES = ['players', 'sessions', 'users'];

export async function truncateAll(handle: DbHandle): Promise<void> {
  await handle.pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export interface TestUser {
  userId: string;
  token: string;
}

/** Inserts a `users` row and a live `sessions` row, returning the raw (hex) session token. */
export async function createTestUserWithSession(handle: DbHandle, expiresInMs = 30 * 24 * 60 * 60 * 1000): Promise<TestUser> {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const userResult = await handle.pool.query<{ id: string }>(
    'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id',
    [`sim-test-${unique}@keysrun.test`, 'sim-never-checks-this', `SimTest-${unique}`],
  );
  const userId = userResult.rows[0].id;
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + expiresInMs);
  await handle.pool.query('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [userId, tokenHash, expiresAt]);
  return { userId, token };
}
