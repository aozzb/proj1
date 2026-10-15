import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Centralized test connection config. Tests run on the host against the compose
 * Postgres (localhost:5433) and Redis (localhost:6379), but on an ISOLATED test
 * database (webhook_test) and Redis DB index (/1) so they never touch dev data.
 *
 * Password resolution: env var first, then .env file, then the dev default. CI
 * sets TEST_* env vars explicitly.
 */
function parseEnvFile(): Record<string, string> {
  const p = resolve(process.cwd(), '.env');
  if (!existsSync(p)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

const file = parseEnvFile();

// Resolve the Postgres password from the environment or the local .env file.
// No hardcoded fallback — we never embed a secret in the repo. If a full
// TEST_DATABASE_URL is supplied (e.g. in CI) the password is not needed.
function pgPassword(): string {
  const pw = process.env.POSTGRES_PASSWORD || file.POSTGRES_PASSWORD;
  if (!pw) {
    throw new Error(
      'Tests need the Postgres password: set POSTGRES_PASSWORD (or a .env with it), ' +
        'or provide TEST_DATABASE_URL / TEST_ADMIN_DATABASE_URL directly.'
    );
  }
  return pw;
}

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  `postgres://webhook_user:${pgPassword()}@localhost:5433/webhook_test`;
export const ADMIN_DATABASE_URL =
  process.env.TEST_ADMIN_DATABASE_URL ||
  `postgres://webhook_user:${pgPassword()}@localhost:5433/webhook_db`;
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379/1';

/** Set env vars the src modules read at import. Must run before importing src. */
export function applyTestEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.REDIS_URL = TEST_REDIS_URL;
  process.env.SSRF_ALLOW_PRIVATE = 'true'; // local test receiver is 127.0.0.1
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
  // Small clock so a full retry->dead cycle finishes in ~1-2s.
  process.env.DELIVERY_TIMEOUT_MS = '1000';
  process.env.MAX_ATTEMPTS = process.env.MAX_ATTEMPTS || '4';
  process.env.BACKOFF_BASE_MS = '50';
  process.env.BACKOFF_CAP_MS = '400';
  // Permissive throttles + a breaker that won't trip during retry/DLQ tests.
  process.env.ENDPOINT_RATE_LIMIT_PER_SEC = '1000';
  process.env.ENDPOINT_MAX_CONCURRENCY = '100';
  process.env.CB_FAILURE_THRESHOLD = process.env.CB_FAILURE_THRESHOLD || '100';
  process.env.CB_OPEN_MS = '1000';
}
