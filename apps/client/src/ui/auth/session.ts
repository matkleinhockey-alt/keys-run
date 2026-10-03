/**
 * Session persistence: "session token held in memory + sessionStorage" (task brief). In-memory
 * is the source of truth for the running session (net/client.ts reads it synchronously);
 * sessionStorage survives a page reload within the same tab but — unlike localStorage —
 * disappears when the tab/window closes, which is the right lifetime for a session token (no
 * "stay logged in forever on a shared computer" footgun, while still surviving an accidental
 * refresh mid-game).
 */

export interface Session {
  token: string;
  userId: string;
  displayName: string;
}

const STORAGE_KEY = 'keysrun.session.v1';

let current: Session | null = null;

export function saveSession(session: Session): void {
  current = session;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage disabled (private mode, quota) — in-memory session still works for this tab.
  }
}

export function loadSavedSession(): Session | null {
  if (current) return current;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (typeof parsed.token !== 'string' || typeof parsed.userId !== 'string' || typeof parsed.displayName !== 'string') return null;
    current = { token: parsed.token, userId: parsed.userId, displayName: parsed.displayName };
    return current;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  current = null;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function getCurrentSession(): Session | null {
  return current;
}
