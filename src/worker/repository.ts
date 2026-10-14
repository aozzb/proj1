import { pool } from '../lib/db';

/** Everything the worker needs to attempt a delivery, loaded fresh from Postgres. */
export interface DeliveryContext {
  deliveryId: string;
  status: string;
  attemptsCount: number;
  eventId: string;
  eventType: string;
  payload: unknown;
  endpointId: string;
  url: string;
  secret: string;
  rateLimitPerSec: number | null;
  maxConcurrency: number | null;
}

/**
 * Load the delivery joined with its event and endpoint. Returns null if the
 * delivery no longer exists (e.g. the application was deleted).
 */
export async function loadDeliveryContext(deliveryId: string): Promise<DeliveryContext | null> {
  const { rows } = await pool.query(
    `SELECT d.id            AS "deliveryId",
            d.status        AS "status",
            d.attempts_count AS "attemptsCount",
            e.id            AS "eventId",
            e.type          AS "eventType",
            e.payload       AS "payload",
            ep.id           AS "endpointId",
            ep.url          AS "url",
            ep.secret       AS "secret",
            ep.rate_limit_per_sec AS "rateLimitPerSec",
            ep.max_concurrency    AS "maxConcurrency"
     FROM deliveries d
     JOIN events e     ON e.id = d.event_id
     JOIN endpoints ep ON ep.id = d.endpoint_id
     WHERE d.id = $1`,
    [deliveryId]
  );
  return (rows[0] as DeliveryContext | undefined) ?? null;
}

export interface AttemptRecord {
  deliveryId: string;
  attemptNumber: number;
  statusCode: number | null;
  latencyMs: number;
  error: string | null;
  responseSnippet: string | null;
}

/** Append one row to the immutable attempt log. Called on every attempt. */
export async function recordAttempt(a: AttemptRecord): Promise<void> {
  await pool.query(
    `INSERT INTO delivery_attempts
       (delivery_id, attempt_number, status_code, latency_ms, error, response_snippet)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [a.deliveryId, a.attemptNumber, a.statusCode, a.latencyMs, a.error, a.responseSnippet]
  );
}

export async function markSucceeded(deliveryId: string, attemptNumber: number): Promise<void> {
  await pool.query(
    `UPDATE deliveries
     SET status = 'succeeded', attempts_count = $2, last_error = NULL
     WHERE id = $1`,
    [deliveryId, attemptNumber]
  );
}

/** Permanent (non-retryable) failure, e.g. a 4xx. */
export async function markFailed(
  deliveryId: string,
  attemptNumber: number,
  error: string
): Promise<void> {
  await pool.query(
    `UPDATE deliveries
     SET status = 'failed', attempts_count = $2, last_error = $3
     WHERE id = $1`,
    [deliveryId, attemptNumber, error]
  );
}

/** Retries remain: stay pending, record when the next attempt is due (for observability). */
export async function markPendingRetry(
  deliveryId: string,
  attemptNumber: number,
  nextDelayMs: number,
  error: string
): Promise<void> {
  await pool.query(
    `UPDATE deliveries
     SET status = 'pending',
         attempts_count = $2,
         next_attempt_at = now() + ($3 || ' milliseconds')::interval,
         last_error = $4
     WHERE id = $1`,
    [deliveryId, attemptNumber, String(nextDelayMs), error]
  );
}

/** Retries exhausted: terminal failure, eligible for the DLQ (CP4). */
export async function markDead(
  deliveryId: string,
  attemptNumber: number,
  error: string
): Promise<void> {
  await pool.query(
    `UPDATE deliveries
     SET status = 'dead', attempts_count = $2, last_error = $3
     WHERE id = $1`,
    [deliveryId, attemptNumber, error]
  );
}
