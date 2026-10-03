/**
 * Zod-validated environment loading. Fails fast at boot (not three requests
 * later) if something required is missing or malformed. See .env.example at
 * the repo root for what each variable means.
 */
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Best-effort: load the repo-root `.env` into process.env before validating,
// so `pnpm db:migrate` / `pnpm db:seed` / `pnpm dev` work right after
// `cp .env.example .env` with no manual `export`. In production (Railway)
// there is no `.env` file — env vars are injected directly — so a missing
// file is silently ignored, and anything already present in process.env
// (CI, Railway, a real shell export) is never overwritten.
try {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '../../..');
  process.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
  // No .env file (production) or Node too old to support loadEnvFile — fall
  // through to whatever is already in process.env.
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(source);
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
