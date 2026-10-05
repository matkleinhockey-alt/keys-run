/**
 * The "subtle banner" docs/ARCHITECTURE.md's reconnect-and-resume section calls for: "the client
 * keeps rendering throughout, freezes remote entities, shows a subtle banner, and resumes."
 * Deliberately not a modal/overlay — it never blocks input or the render loop, just a small
 * pill at the top of the screen that fades in/out, so "no loading screen" stays true even while
 * reconnecting.
 */
import type { ConnectionState } from './client.js';
import './net.css';

export interface Banner {
  setState(state: ConnectionState, detail?: { nextRetryMs?: number; etaMs?: number }): void;
  showServerRestart(etaMs: number): void;
  dispose(): void;
}

const MESSAGES: Record<ConnectionState, (detail?: { nextRetryMs?: number }) => string> = {
  connecting: () => 'Connecting to the shared world…',
  connected: () => 'Connected — fishing with others',
  reconnecting: (d) => `Reconnecting${d?.nextRetryMs ? ` in ${Math.ceil(d.nextRetryMs / 1000)}s…` : '…'} (keep playing)`,
  auth_failed: () => 'Session expired — playing offline',
  closed: () => 'Disconnected',
};

const KIND: Record<ConnectionState, string> = {
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'reconnecting',
  auth_failed: 'offline',
  closed: 'offline',
};

export function createBanner(wrap: HTMLElement): Banner {
  const el = document.createElement('div');
  el.className = 'krNetBanner';
  el.setAttribute('data-visible', 'false');
  wrap.appendChild(el);

  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function show(text: string, kind: string, autoHideMs: number | null): void {
    el.textContent = text;
    el.setAttribute('data-kind', kind);
    el.setAttribute('data-visible', 'true');
    if (hideTimer) clearTimeout(hideTimer);
    if (autoHideMs !== null) hideTimer = setTimeout(() => el.setAttribute('data-visible', 'false'), autoHideMs);
  }

  return {
    setState(state, detail) {
      // "connected" is reassuring exactly once (briefly), not a permanent fixture — a quiet HUD
      // is the point. Every other state stays up for as long as it's true.
      show(MESSAGES[state](detail), KIND[state], state === 'connected' ? 2500 : null);
    },
    showServerRestart(etaMs) {
      show(`Server restarting — reconnecting in ~${Math.ceil(etaMs / 1000)}s`, 'reconnecting', null);
    },
    dispose() {
      if (hideTimer) clearTimeout(hideTimer);
      el.remove();
    },
  };
}
