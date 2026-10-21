import { defineConfig } from 'vite';

/**
 * Build-time guard: a production bundle must know where its backend is.
 *
 * `src/net/config.ts` falls back to `http://localhost:8080` when `VITE_API_URL` is unset, which
 * is right for `pnpm dev` and catastrophic in a deployed build — every visitor's browser then
 * asks *their own machine* for the leaderboard, silently gets nothing, and the game looks like it
 * simply has no scores. That shipped: the bundle live on keys-run.vercel.app contains
 * `http://localhost:8080`, and the leaderboard had never received a single real catch.
 *
 * Nothing about that failure is loud. There is no error, no 500, no red console text worth
 * noticing — a connection to localhost just fails the way a connection to a service you haven't
 * started fails. So the only reliable place to catch it is here, before the artifact exists.
 *
 * Escape hatch: set `VITE_ALLOW_LOCALHOST_API=1` to build a production bundle that really does
 * point at localhost (packaging the client to run beside a local stack, or a bundle-size check).
 */
function assertBackendConfigured(mode: string): void {
  if (mode !== 'production') return;
  if (process.env.VITE_ALLOW_LOCALHOST_API === '1') return;
  const api = process.env.VITE_API_URL;
  const ws = process.env.VITE_SIM_WS_URL;
  const missing = [!api && 'VITE_API_URL', !ws && 'VITE_SIM_WS_URL'].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `Production build is missing ${missing.join(' and ')}.\n` +
      'Without it the bundle points at http://localhost:8080, so every visitor asks their own\n' +
      'machine for the leaderboard and silently sees nothing. Set these in the Vercel project\n' +
      "settings (or the deploy environment) to the backend's public URLs, e.g.\n" +
      '  VITE_API_URL=https://api-production-xxxx.up.railway.app\n' +
      '  VITE_SIM_WS_URL=wss://sim-production-xxxx.up.railway.app\n' +
      'See docs/DEPLOYMENT.md. To build a localhost bundle on purpose: VITE_ALLOW_LOCALHOST_API=1.',
    );
  }
  // A page served over https cannot call http:// or ws:// — the browser blocks it as mixed
  // content, with the same silent-looking result as the bug above.
  for (const [name, value, bad, good] of [
    ['VITE_API_URL', api!, 'http://', 'https://'],
    ['VITE_SIM_WS_URL', ws!, 'ws://', 'wss://'],
  ] as const) {
    if (value.startsWith(bad)) {
      throw new Error(
        `${name} is ${value}, which a https:// page cannot reach — browsers block mixed content.\n` +
        `Use ${good} instead.`,
      );
    }
  }
}

export default defineConfig(({ mode }) => {
  assertBackendConfigured(mode);
  return {
    server: {
      port: 5173,
    },
  };
});
