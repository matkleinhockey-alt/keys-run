/**
 * The auth gate: register/login against apps/api, or "play offline" — task brief: "Gate entry
 * to the game on being logged in, with a clearly-marked 'play offline' path that still works
 * (the game must never hard-require a server to be playable)."
 *
 * `mountAuthGate()` resolves exactly once, with either an online session (token + identity, for
 * main.ts to hand to net/client.ts) or the offline choice. If a saved, still-valid session exists
 * (ui/auth/session.ts, sessionStorage) it resolves immediately with *no UI shown at all* — the
 * gate is a login prompt, not a mandatory splash screen for returning players.
 */
import { login, logout, me, register, ApiError } from './api.js';
import { saveSession, loadSavedSession, clearSession, type Session } from './session.js';
import './auth.css';

export type GateResult = { mode: 'online'; token: string; userId: string; displayName: string } | { mode: 'offline' };

const VALIDATE_TIMEOUT_MS = 3000;

async function validateSavedSession(session: Session): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  try {
    await me(session.token);
    return true;
  } catch (err) {
    // A clear auth rejection (expired/revoked) invalidates the saved session; a network error
    // (api down) does not — we just can't confirm it right now, so fall through to the gate UI
    // rather than silently discarding a token that might still be good.
    if (err instanceof ApiError && err.status === 401) return false;
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function mountAuthGate(): Promise<GateResult> {
  const saved = loadSavedSession();
  if (saved) {
    const ok = await validateSavedSession(saved);
    if (ok) return { mode: 'online', token: saved.token, userId: saved.userId, displayName: saved.displayName };
    clearSession();
  }
  return new Promise<GateResult>((resolve) => {
    buildGateUI(resolve);
  });
}

/** Exposed so a header "log out" control elsewhere (ui/leaderboard/panel.ts) can end the session
 * without duplicating the API call + storage-clear logic. Reloads the page: the simplest correct
 * way to fully unwind an in-progress net connection + rendered world back to the gate. */
export async function logOutAndReload(token: string): Promise<void> {
  try { await logout(token); } catch { /* best-effort */ }
  clearSession();
  location.reload();
}

function buildGateUI(resolve: (r: GateResult) => void): void {
  const overlay = document.createElement('div');
  overlay.className = 'krAuthGate';
  overlay.innerHTML = `
    <div class="krAuthCard">
      <h1 class="krAuthTitle">Keys<span>Run</span></h1>
      <p class="krAuthSub">Log in for the shared world, a real leaderboard, and your records — or skip it and fish solo.</p>
      <div class="krAuthTabs" role="tablist">
        <button type="button" data-tab="login" aria-pressed="true">Log in</button>
        <button type="button" data-tab="register" aria-pressed="false">Register</button>
      </div>
      <form class="krAuthForm" novalidate>
        <label>Email<input type="email" name="email" autocomplete="email" required></label>
        <label class="krField-displayName hidden">Display name<input type="text" name="displayName" autocomplete="nickname" minlength="3" maxlength="20"></label>
        <label>Password<input type="password" name="password" autocomplete="current-password" required minlength="8"></label>
        <div class="krAuthError" role="alert"></div>
        <button type="submit" class="krAuthSubmit">Log in</button>
      </form>
      <div class="krAuthDivider">or</div>
      <button type="button" class="krAuthOffline">Play offline</button>
      <p class="krAuthOfflineNote">No account needed — single-player, exactly as before. You can log in later.</p>
    </div>
  `;
  document.body.appendChild(overlay);

  const tabs = overlay.querySelectorAll<HTMLButtonElement>('[data-tab]');
  const form = overlay.querySelector('form') as HTMLFormElement;
  const displayNameField = overlay.querySelector('.krField-displayName') as HTMLElement;
  const displayNameInput = form.elements.namedItem('displayName') as HTMLInputElement;
  const errorEl = overlay.querySelector('.krAuthError') as HTMLElement;
  const submitBtn = overlay.querySelector('.krAuthSubmit') as HTMLButtonElement;
  const offlineBtn = overlay.querySelector('.krAuthOffline') as HTMLButtonElement;

  let mode: 'login' | 'register' = 'login';

  function setMode(next: 'login' | 'register'): void {
    mode = next;
    tabs.forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.tab === next)));
    displayNameField.classList.toggle('hidden', next === 'login');
    displayNameInput.required = next === 'register';
    submitBtn.textContent = next === 'login' ? 'Log in' : 'Create account';
    errorEl.textContent = '';
  }
  tabs.forEach((t) => t.addEventListener('click', () => setMode(t.dataset.tab as 'login' | 'register')));

  function finish(result: GateResult): void {
    overlay.remove();
    resolve(result);
  }

  offlineBtn.addEventListener('click', () => finish({ mode: 'offline' }));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void submit();
  });

  async function submit(): Promise<void> {
    const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim();
    const password = (form.elements.namedItem('password') as HTMLInputElement).value;
    const displayName = displayNameInput.value.trim();

    errorEl.textContent = '';
    submitBtn.disabled = true;
    offlineBtn.disabled = true;
    try {
      if (mode === 'register') {
        await register(email, password, displayName);
      }
      const loginResult = await login(email, password);
      const profile = await me(loginResult.token);
      const session: Session = { token: loginResult.token, userId: profile.user.id, displayName: profile.user.displayName };
      saveSession(session);
      finish({ mode: 'online', token: session.token, userId: session.userId, displayName: session.displayName });
    } catch (err) {
      errorEl.textContent = err instanceof ApiError ? err.message : 'Something went wrong. Try again, or play offline.';
      submitBtn.disabled = false;
      offlineBtn.disabled = false;
    }
  }

  setMode('login');
}
