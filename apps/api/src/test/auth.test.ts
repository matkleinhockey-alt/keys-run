import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { DbHandle } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { hashSessionToken } from '../lib/auth.js';
import { buildTestApp, loginUser, registerUser, testDbHandle, truncateAll } from './helpers.js';

describe('auth', () => {
  let handle: DbHandle;
  let app: FastifyInstance;

  beforeAll(() => {
    handle = testDbHandle();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await truncateAll(handle);
    app = await buildTestApp(handle);
  });

  afterEach(async () => {
    await app.close();
  });

  it('round-trips register -> login -> /me', async () => {
    const user = await registerUser(app, { email: 'round-trip@keysrun.test', displayName: 'Round Tripper' });
    const { token, expiresAt } = await loginUser(app, user.email, user.password);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    const body = me.json() as { user: { id: string; email: string; displayName: string }; player: { resume: unknown } };
    expect(body.user.id).toBe(user.id);
    expect(body.user.email).toBe('round-trip@keysrun.test');
    expect(body.user.displayName).toBe('Round Tripper');
    expect(body.player.resume).toEqual({});
  });

  it('rejects a duplicate email (case-insensitive)', async () => {
    await registerUser(app, { email: 'dup@keysrun.test', displayName: 'First Name' });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'DUP@keysrun.test', password: 'another-password', displayName: 'Second Name' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('email') });
  });

  it('rejects a duplicate display name (case-insensitive)', async () => {
    await registerUser(app, { email: 'name-a@keysrun.test', displayName: 'Taken Name' });
    const res = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'name-b@keysrun.test', password: 'another-password', displayName: 'taken name' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('display name') });
  });

  it('rejects a display name outside 3-20 characters', async () => {
    const tooShort = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'short@keysrun.test', password: 'password123', displayName: 'ab' },
    });
    expect(tooShort.statusCode).toBe(400);

    const tooLong = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'long@keysrun.test', password: 'password123', displayName: 'x'.repeat(21) },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('rejects wrong password and unknown email with indistinguishable responses', async () => {
    const user = await registerUser(app, { email: 'known@keysrun.test', displayName: 'Known User' });

    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: user.email, password: 'definitely-not-it' },
    });
    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody-registered@keysrun.test', password: 'whatever-password' },
    });

    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);
    expect(wrongPassword.json()).toEqual(unknownEmail.json());
  });

  it('revokes the session on logout', async () => {
    const user = await registerUser(app, { email: 'logout@keysrun.test', displayName: 'Logout User' });
    const { token } = await loginUser(app, user.email, user.password);

    const before = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } });
    expect(before.statusCode).toBe(200);

    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { authorization: `Bearer ${token}` } });
    expect(logout.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } });
    expect(after.statusCode).toBe(401);
  });

  it('rejects an expired session', async () => {
    const user = await registerUser(app, { email: 'expired@keysrun.test', displayName: 'Expired User' });

    // Insert an already-expired session directly — faster and more precise
    // than waiting out SESSION_TTL_MS in a test.
    const rawToken = 'a'.repeat(64);
    await handle.db.insert(sessions).values({
      userId: user.id,
      tokenHash: hashSessionToken(rawToken),
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${rawToken}` } });
    expect(res.statusCode).toBe(401);

    const row = await handle.db.select().from(sessions).where(eq(sessions.userId, user.id)).limit(1);
    expect(row[0].expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it('rate-limits /auth/login to 10 attempts per 15 minutes per IP', async () => {
    const payload = { email: 'rate-limit-target@keysrun.test', password: 'whatever-password' };
    let lastStatus = 0;
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({ method: 'POST', url: '/auth/login', payload });
      lastStatus = res.statusCode;
      if (i < 10) expect(res.statusCode).toBe(401);
    }
    expect(lastStatus).toBe(429);
  });
});
