/**
 * Zod-validated environment loading, mirroring apps/api/src/env.ts's "fail fast at boot" shape.
 *
 * Port: docs/ARCHITECTURE.md's lifecycle section specifies binding `0.0.0.0:${PORT:-8081}` —
 * Railway hands each deployed service its own `PORT`, so in production this is always `PORT`.
 * Locally, `api` and `sim` often run side by side off the same repo-root `.env`; reading `PORT`
 * directly there would collide with apps/api's own `PORT=8080`. `SIM_PORT` (checked first, with
 * `PORT` as the documented fallback, defaulting to 8081) resolves that without weakening the
 * literal `${PORT:-8081}` contract Railway actually exercises.
 */
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '../../..');
  process.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
  // No .env file (production) or Node too old for loadEnvFile — fall through to process.env.
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8081),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // Fixed 30 Hz per docs/ARCHITECTURE.md ("20 Hz gives 50 ms quantization... 1.25 m of slop").
  // Exposed as an env override only so tests can run the loop faster/slower; never meant to
  // change in production — the degradation ladder's "sim to 20 Hz" step is a future, explicit
  // broadcast-and-switch operation, not a knob to fiddle with here.
  TICK_HZ: z.coerce.number().positive().default(30),
  SNAPSHOT_HZ: z.coerce.number().positive().default(15),
  MAX_PLAYERS: z.coerce.number().int().positive().max(511).default(256),
  AUTOSAVE_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const normalized = { ...source, PORT: source.SIM_PORT ?? source.PORT ?? '8081' };
  const parsed = EnvSchema.safeParse(normalized);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test-only: forget the cached env so a test can reload with different values. */
export function resetEnvCache(): void {
  cached = undefined;
}
