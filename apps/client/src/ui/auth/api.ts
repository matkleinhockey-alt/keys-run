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
    const message = (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') ? body.error : `Request failed (${res.status})`;
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
