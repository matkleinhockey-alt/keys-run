/**
 * POST /catches — reports a landed fish to apps/api so the leaderboard can show it. Called from
 * game/catch/catch-flow.ts's `landFish`, the one path both rod fishing and spearfishing funnel a
 * landed fish through.
 *
 * Reads the session the same way ui/auth/gate.ts leaves it (ui/auth/session.ts's in-memory
 * `getCurrentSession()`) rather than taking the identity as a constructor arg — catch-flow.ts is
 * built deep inside game/world.ts's `initWorld()`, which has no session info threaded through it,
 * and the session is a singleton for the tab's lifetime (main.ts never re-mounts the gate), so
 * reading it lazily here avoids threading identity through every layer in between.
 *
 * Deliberately fire-and-forget and silent on every failure path: "Play offline" (ui/auth/gate.ts)
 * is a real, fully supported mode with no account and no server, and even a logged-in player's
 * connection can drop mid-session. Either way, this must never throw into game/world.ts's frame()
 * loop or delay/interrupt the catch card — the catch has already been scored and shown locally by
 * the time this is called. See apps/api/src/routes/catches.ts's doc comment for what the server
 * side of this write does and does not prove — this is just the client half of that same
 * deliberately-interim step, not a claim of real server authority.
 */
import { API_BASE_URL } from '../../net/config.js';
import { getCurrentSession } from '../auth/session.js';

/** Fired on the server confirming the write (2xx) — ui/leaderboard/panel.ts listens for this to
 * refresh an already-open panel without a page reload. Never fired when offline/logged out, and
 * never fired (nor does anything else happen) on a network error or a non-2xx response. */
export const CATCH_SUBMITTED_EVENT = 'keysrun:catch-submitted';

export function submitCatch(speciesKey: string, weightLb: number): void {
  const session = getCurrentSession();
  if (!session) return; // offline or logged out — nothing to submit, nothing to await

  void fetch(`${API_BASE_URL}/catches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ speciesKey, weightLb }),
  })
    .then((res) => {
      if (res.ok) {
        window.dispatchEvent(new CustomEvent(CATCH_SUBMITTED_EVENT, { detail: { speciesKey, weightLb } }));
      }
      // A non-2xx (expired session, flagged-but-still-201 so this branch is really just
      // 4xx/5xx, rate limited, api down) is not surfaced anywhere — see this file's header.
    })
    .catch(() => {
      // Offline, DNS failure, CORS misconfig, api down mid-request. Swallow it: the local catch
      // flow already completed before this was ever called.
    });
}
