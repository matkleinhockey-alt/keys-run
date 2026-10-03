/**
 * Shared integration-test helpers. Every test file gets its own `DbHandle`
 * (one pg Pool) against TEST_DATABASE_URL, truncates all tables before each
 * test for isolation, and builds a fresh Fastify app per test so
 * @fastify/rate-limit's in-memory counters never leak between tests.
 */
import '../env.js'; // side-effect: loads repo-root .env
import { createDb, type DbHandle } from '../db/client.js';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';

export function testDbHandle(): DbHandle {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set — see .env.example');
  return createDb(url);
}

const TABLES = ['audit_flags', 'species_records', 'global_records', 'catches', 'players', 'sessions', 'users', 'world'];

export async function truncateAll(handle: DbHandle): Promise<void> {
  await handle.pool.query(`TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export async function buildTestApp(handle: DbHandle, corsOrigin: string[] = ['http://localhost:5173']): Promise<FastifyInstance> {
  return buildApp({ db: handle.db, pool: handle.pool, corsOrigin, logger: false });
}

export interface RegisteredUser {
  id: string;
  email: string;
  displayName: string;
  password: string;
}

export async function registerUser(
  app: FastifyInstance,
  overrides: Partial<{ email: string; password: string; displayName: string }> = {},
): Promise<RegisteredUser> {
  const unique = Math.random().toString(36).slice(2, 10);
  const body = {
    email: overrides.email ?? `user-${unique}@keysrun.test`,
    password: overrides.password ?? 'correct-horse-battery',
    displayName: overrides.displayName ?? `Angler ${unique.slice(0, 6)}`,
  };
  const res = await app.inject({ method: 'POST', url: '/auth/register', payload: body });
  if (res.statusCode !== 201) {
    throw new Error(`registerUser failed: ${res.statusCode} ${res.body}`);
  }
  const parsed = res.json() as { user: { id: string; email: string; displayName: string } };
  return { id: parsed.user.id, email: parsed.user.email, displayName: parsed.user.displayName, password: body.password };
}

export async function loginUser(app: FastifyInstance, email: string, password: string): Promise<{ token: string; expiresAt: string }> {
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  if (res.statusCode !== 200) {
    throw new Error(`loginUser failed: ${res.statusCode} ${res.body}`);
  }
  return res.json() as { token: string; expiresAt: string };
}
