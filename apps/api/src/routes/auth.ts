/**
 * /auth/register, /auth/login, /auth/logout.
 *
 * Login failure must be indistinguishable between "wrong password" and
 * "unknown email" (task brief) — both return the same 401 + message, and the
 * "unknown email" path still runs an argon2 verify against a fixed dummy hash
 * so the response takes comparable wall-clock time either way (defends
 * against a timing side-channel for user enumeration; argon2id dominates the
 * request's latency, so skipping it on the "no such user" path would be the
 * actual timing tell).
 *
 * Rate limiting (10 attempts / 15 min / IP) is applied per-route via the
 * `config.rateLimit` override on a plugin-scoped @fastify/rate-limit
 * instance registered with `global: false` in app.ts.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { users, players } from '../db/schema.js';
import { hashPassword, verifyPassword } from '../lib/auth.js';
import { createSession, revokeSession } from '../lib/sessions.js';

// RFC9106-ish dummy hash so the "no such account" branch pays the same
// argon2.verify() cost as a real mismatch. Generated once at module load from
// a fixed password+salt-equivalent; never used to authenticate anything.
const DUMMY_HASH = await hashPassword('dummy-password-for-timing-only');

const DISPLAY_NAME_RE = /^[\p{L}\p{N} _'-]{3,20}$/u;

const RegisterBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8).max(128),
  displayName: z
    .string()
    .trim()
    .regex(DISPLAY_NAME_RE, 'display name must be 3-20 characters (letters, numbers, spaces, _ - \')'),
});

const LoginBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});

const RATE_LIMIT = { max: 10, timeWindow: '15 minutes' } as const;

export default async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/auth/register', { config: { rateLimit: RATE_LIMIT } }, async (request, reply) => {
    const parsed = RegisterBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid request body' });
    }
    const { email, password, displayName } = parsed.data;
    const passwordHash = await hashPassword(password);

    try {
      const user = await fastify.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values({ email, passwordHash, displayName })
          .returning({ id: users.id, email: users.email, displayName: users.displayName, createdAt: users.createdAt });
        await tx.insert(players).values({ userId: row.id });
        return row;
      });
      return reply.code(201).send({ user });
    } catch (err: unknown) {
      // drizzle-orm wraps the underlying pg DatabaseError as `.cause` rather
      // than exposing `.constraint` directly on the thrown error — confirmed
      // empirically against drizzle-orm 0.45 / pg 8.23, not documented
      // anywhere obvious. Check both so this survives a drizzle upgrade that
      // changes the wrapping.
      type PgLikeError = { constraint?: string; cause?: { constraint?: string } };
      const pgErr = err as PgLikeError;
      const constraint = pgErr?.constraint ?? pgErr?.cause?.constraint;
      if (constraint === 'users_email_lower_idx') {
        return reply.code(409).send({ error: 'an account with this email already exists' });
      }
      if (constraint === 'users_display_name_lower_idx') {
        return reply.code(409).send({ error: 'that display name is already taken' });
      }
      throw err;
    }
  });

  fastify.post('/auth/login', { config: { rateLimit: RATE_LIMIT } }, async (request, reply) => {
    const parsed = LoginBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'invalid request body' });
    }
    const { email, password } = parsed.data;

    const INVALID = { error: 'invalid email or password' };

    const rows = await fastify.db
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    const user = rows[0];

    if (!user) {
      await verifyPassword(DUMMY_HASH, password); // pay the same cost as a real mismatch
      return reply.code(401).send(INVALID);
    }

    const ok = await verifyPassword(user.passwordHash, password);
    if (!ok) {
      return reply.code(401).send(INVALID);
    }

    const session = await createSession(fastify.db, user.id);
    return reply.code(200).send({ token: session.token, expiresAt: session.expiresAt });
  });

  fastify.post('/auth/logout', { config: { rateLimit: RATE_LIMIT }, preHandler: fastify.requireSession }, async (request, reply) => {
    const auth = request.headers.authorization;
    const token = /^Bearer\s+(.+)$/i.exec(auth ?? '')?.[1]?.trim();
    if (token) {
      await revokeSession(fastify.db, token);
    }
    return reply.code(204).send();
  });
}
