/**
 * Session-auth preHandler. Reads `Authorization: Bearer <token>`, resolves it
 * against `sessions` (hashed, constant-time compare — see lib/auth.ts), and
 * sets `request.userId`. Routes that require a session use
 * `{ preHandler: fastify.requireSession }`.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { resolveSession } from '../lib/sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
  interface FastifyInstance {
    requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export default fp(async function authPlugin(fastify: FastifyInstance) {
  fastify.decorateRequest('userId', undefined);

  fastify.decorate('requireSession', async function requireSession(request: FastifyRequest, reply: FastifyReply) {
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      return reply.code(401).send({ error: 'missing or malformed Authorization header' });
    }
    const session = await resolveSession(fastify.db, token);
    if (!session) {
      return reply.code(401).send({ error: 'invalid or expired session' });
    }
    request.userId = session.userId;
  });
});
