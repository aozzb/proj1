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
