import { z } from 'zod';

/**
 * Validate the environment once, at startup, and fail fast if anything is
 * missing or malformed. Everywhere else imports `env` and trusts it, so we
 * never sprinkle `process.env.FOO!` (and silent `undefined`) through the code.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // --- CP3 delivery/worker config (defaults so the API process is unaffected) ---
  // Hard timeout for each outbound POST (engineering rule: 5-10s).
  DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  // Total attempts per delivery before it is marked dead.
  MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
  // Exponential backoff: delay = min(cap, base * 2^(attemptsMade-1)), then full jitter.
  BACKOFF_BASE_MS: z.coerce.number().int().positive().default(1000),
  BACKOFF_CAP_MS: z.coerce.number().int().positive().default(300000),
  // How many deliveries a single worker processes concurrently.
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(10),
  // Replay-protection window for signature verification (receiver side).
  SIGNATURE_TOLERANCE_SEC: z.coerce.number().int().positive().default(300),

  // --- CP4 reliability config (all defaulted; additive) ---
  // SSRF: block private/loopback/link-local IPs for endpoint URLs. Set to "true"
  // ONLY in local/dev so the in-cluster chaos receiver (a private IP) is reachable.
  // (enum+transform, not z.coerce.boolean, because coercion treats "false" as true.)
  SSRF_ALLOW_PRIVATE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Per-endpoint delivery throttles (permissive defaults so existing flows are unaffected).
  ENDPOINT_RATE_LIMIT_PER_SEC: z.coerce.number().int().positive().default(100),
  ENDPOINT_MAX_CONCURRENCY: z.coerce.number().int().positive().default(20),
  // Circuit breaker (per endpoint).
  CB_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  CB_OPEN_MS: z.coerce.number().int().positive().default(30000),
  CB_HALF_OPEN_MAX: z.coerce.number().int().positive().default(1),
  // Reconciling sweeper (scheduler process).
  SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  SWEEP_BATCH: z.coerce.number().int().positive().default(100),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Don't use the pino logger here: config is a dependency of the logger, and
  // if config is broken we want the rawest possible message to stderr.
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
