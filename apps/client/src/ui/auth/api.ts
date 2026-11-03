/**
 * Thin fetch wrapper over apps/api's auth routes (apps/api/src/routes/auth.ts, me.ts). No
 * framework, no retries — this is a login form's backend, not the game's live connection (that's
 * net/client.ts's job against apps/sim). Every function throws `ApiError` with the server's own
 * `{error}` message on a non-2xx response, which gate.ts surfaces directly in the form.
 */
import { API_BASE_URL } from '../../net/config.js';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection.', 0);
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    /*
     * "The server is not there" is not the same as "the server said no", and a player cannot act
     * on the difference unless we tell them.
     *
     * The `catch` above only fires when the request never completes. A host that ANSWERS but has
     * no application behind it lands here instead, and Railway's edge does exactly that: a
     * suspended project returns `{"status":"error","code":404,"message":"Application not found"}`
     * — note `message`, not `error`, so it fell through to the literal string "Request failed
     * (404)" on the login panel. Observed live.
     *
     * Our own auth routes never 404 a real request (bad credentials are 401, a taken address is
     * 409), so a 404 here means the backend is missing rather than the account being wrong. Same
     * for the gateway statuses. Say so, and point at the thing that still works — the game runs
     * fully offline.
     */
    const gone = res.status === 404 || res.status === 502 || res.status === 503 || res.status === 504;
    const fromApi = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : null;
    const message = fromApi
      ?? (gone ? 'Game server is unavailable right now — you can still Play offline below.' : `Request failed (${res.status})`);
    throw new ApiError(message, res.status);
  }
  return body as T;
}

export interface RegisterResult {
  user: { id: string; email: string; displayName: string; createdAt: string };
}

export function register(email: string, password: string, displayName: string): Promise<RegisterResult> {
  return request<RegisterResult>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, displayName }) });
}

export interface LoginResult {
  token: string;
  expiresAt: string;
}

export function login(email: string, password: string): Promise<LoginResult> {
  return request<LoginResult>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export function logout(token: string): Promise<void> {
  return request<void>('/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
}

export interface MeResult {
  user: { id: string; email: string; displayName: string; createdAt: string };
  player: { resume: unknown };
}

export function me(token: string): Promise<MeResult> {
  return request<MeResult>('/me', { headers: { Authorization: `Bearer ${token}` } });
}
