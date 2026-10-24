/**
 * Session persistence. In-memory is the source of truth for the running session (net/client.ts
 * reads it synchronously); localStorage keeps it for the token's life (30 days, apps/api
 * lib/auth.ts), so a player stays signed in to their account — and their saved game
 * (net/cloud-save.ts) — across visits until they log out from the leaderboard panel. It was
 * sessionStorage, which signed everyone out whenever the tab closed; a session saved there by an
 * older build is picked up once and moved.
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage disabled (private mode, quota) — in-memory session still works for this tab.
  }
}

export function loadSavedSession(): Session | null {
  if (current) return current;
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) { localStorage.setItem(STORAGE_KEY, raw); sessionStorage.removeItem(STORAGE_KEY); }
    }
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
    localStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function getCurrentSession(): Session | null {
  return current;
}
