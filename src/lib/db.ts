import { Pool } from 'pg';
import { env } from '../config/env';

/**
 * A single shared connection pool for the whole process. Postgres is the source
 * of truth, so everything that touches it goes through this pool.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // Fail a checkout quickly rather than hanging if the DB is unreachable.
  connectionTimeoutMillis: 5000,
});

/** Lightweight liveness probe used by /health. */
export async function pingDb(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
