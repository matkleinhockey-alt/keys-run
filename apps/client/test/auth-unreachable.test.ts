/**
 * What the login panel says when there is no backend behind the host.
 *
 * A suspended Railway project does not refuse the connection — its edge answers with
 * `{"status":"error","code":404,"message":"Application not found"}`. That has `message`, not
 * `error`, so the panel showed the literal string "Request failed (404)", which tells a player
 * nothing and hides the fact that the game runs perfectly well offline. Observed live.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { login, ApiError } from '../src/ui/auth/api.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

function reply(status: number, body: unknown): void {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

describe('login against a host with no app behind it', () => {
  it('says the server is unavailable and points at offline play', async () => {
    reply(404, { status: 'error', code: 404, message: 'Application not found' });
    await expect(login('a@b.com', 'pw')).rejects.toThrow(/unavailable right now.*Play offline/i);
  });

  it('treats the gateway failures the same way', async () => {
    for (const code of [502, 503, 504]) {
      reply(code, {});
      await expect(login('a@b.com', 'pw')).rejects.toThrow(/unavailable right now/i);
    }
  });

  it('still shows what the API itself said, when the API is the one talking', async () => {
    reply(401, { error: 'invalid email or password' });
    await expect(login('a@b.com', 'pw')).rejects.toThrow('invalid email or password');
  });

  it('a connection that never completes keeps its own message', async () => {
    globalThis.fetch = vi.fn(async () => { throw new TypeError('network'); }) as unknown as typeof fetch;
    await expect(login('a@b.com', 'pw')).rejects.toThrow(/Could not reach the server/i);
  });

  it('carries the status through for callers that branch on it', async () => {
    reply(404, { status: 'error', message: 'Application not found' });
    await login('a@b.com', 'pw').catch((e: unknown) => { expect((e as ApiError).status).toBe(404); });
  });
});
