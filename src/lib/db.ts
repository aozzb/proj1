import { Pool } from 'pg';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * A single shared connection pool for the whole process. Postgres is the source
 * of truth, so everything that touches it goes through this pool.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Fail a checkout quickly rather than hanging if the DB is unreachable.
  connectionTimeoutMillis: 5000,
});

// An idle client can error out from the server side (e.g. the DB restarts or
// drops the connection). Without this listener, pg emits an 'error' event with
// no handler and Node crashes the whole process. We log and let the pool
// replace the connection on the next query instead.
pool.on('error', (err) => {
  logger.error({ err }, 'idle postgres client error (pool will recover)');
});

/** Lightweight liveness probe used by /health. */
export async function pingDb(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
