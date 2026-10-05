/**
 * Local-dev-friendly defaults for the two backend services (task brief: "You will need Postgres
 * and both services running locally"), overridable via Vite env vars so a deployed build can
 * point at real Railway URLs without a code change. apps/api's own default `PORT` is 8080
 * (apps/api/src/env.ts) and apps/sim's is 8081 (apps/sim/src/env.ts) — these mirror that.
 */

function readEnv(key: string): string | undefined {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.[key];
}

export const API_BASE_URL: string = readEnv('VITE_API_URL') ?? 'http://localhost:8080';

export const SIM_WS_URL: string = readEnv('VITE_SIM_WS_URL') ?? 'ws://localhost:8081';
