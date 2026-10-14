import { DelayedError, type Job } from 'bullmq';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { sign } from '../lib/signing';
import type { DeliveryJobData } from '../lib/queue';
import { assertUrlAllowed, SsrfBlockedError } from '../lib/ssrf';
import { backoffDelay } from './backoff';
import { isRetryableStatus } from './classify';
import { acquire } from './limiter';
import { checkGate, onSuccess, onFailure } from './circuit-breaker';
import {
  loadDeliveryContext,
  recordAttempt,
  markSucceeded,
  markFailed,
  markPendingRetry,
  markDead,
} from './repository';

const TERMINAL = new Set(['succeeded', 'failed', 'dead']);
const SNIPPET_MAX = 500;

/**
 * Process one delivery job.
 *
 * Contract with BullMQ-native retries: we THROW only when we want the job
 * retried (retryable failures). We RETURN normally on success and on permanent
 * failures, so BullMQ does not waste the remaining attempts on a dead-permanent
 * error (e.g. a 400).
 */
export async function processDelivery(job: Job<DeliveryJobData>, token?: string): Promise<void> {
  const { deliveryId } = job.data;
  const ctx = await loadDeliveryContext(deliveryId);

  if (!ctx) {
    logger.warn({ deliveryId }, 'delivery not found; dropping job');
    return;
  }

  // At-least-once guard: if a previous run already reached a terminal state
  // (e.g. we succeeded but crashed before the job was acked), do nothing.
  if (TERMINAL.has(ctx.status)) {
    logger.info({ deliveryId, status: ctx.status }, 'delivery already terminal; skipping');
    return;
  }

  // 1-based attempt number aligned with BullMQ's attemptsMade (0 on first run).
  const attemptNumber = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? env.MAX_ATTEMPTS;

  // SSRF re-check at delivery time (defeats DNS rebinding). A blocked URL can
  // never become safe, so treat it as a permanent failure (no retry).
  try {
    await assertUrlAllowed(ctx.url);
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      await recordAttempt({
        deliveryId,
        attemptNumber,
        statusCode: null,
        latencyMs: 0,
        error: `SSRF blocked: ${err.message}`,
        responseSnippet: null,
      });
      await markFailed(deliveryId, attemptNumber, `SSRF blocked: ${err.message}`);
      logger.warn({ deliveryId, url: ctx.url, reason: err.message }, 'delivery blocked by SSRF');
      return;
    }
    throw err;
  }

  // Helper: finalize a retryable failure (consume an attempt) and throw so
  // BullMQ reschedules or, on the last attempt, moves the job to the failed set.
  const failRetryable = async (reason: string, statusCode: number | null) => {
    await recordAttempt({ deliveryId, attemptNumber, statusCode, latencyMs: 0, error: reason, responseSnippet: null });
    if (attemptNumber >= maxAttempts) {
      await markDead(deliveryId, attemptNumber, reason);
      logger.error({ deliveryId, attemptNumber, reason }, 'delivery dead (attempts exhausted)');
    } else {
      await markPendingRetry(deliveryId, attemptNumber, backoffDelay(attemptNumber), reason);
      logger.warn({ deliveryId, attemptNumber, reason }, 'delivery failed; will retry');
    }
    throw new Error(`delivery ${deliveryId} attempt ${attemptNumber} failed: ${reason}`);
  };

  // Circuit breaker gate. Open => skip the POST and fast-fail (still consumes an
  // attempt, so a dead endpoint still reaches the DLQ; we just save the call).
  const gate = await checkGate(ctx.endpointId);
  if (gate === 'open') {
    logger.warn({ deliveryId, endpointId: ctx.endpointId }, 'circuit open; skipping POST');
    await failRetryable('circuit breaker open', null);
    return;
  }

  // Per-endpoint backpressure. Throttled => reschedule WITHOUT consuming an
  // attempt (backpressure is not failure).
  const slot = await acquire(ctx.endpointId, ctx.rateLimitPerSec, ctx.maxConcurrency);
  if (!slot.ok) {
    logger.debug({ deliveryId, endpointId: ctx.endpointId, reason: slot.reason }, 'throttled; rescheduling');
    await job.moveToDelayed(Date.now() + 1000, token);
    throw new DelayedError();
  }

  const body = JSON.stringify(ctx.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = sign(ctx.secret, timestamp, body);

  let statusCode: number | null = null;
  let error: string | null = null;
  let responseSnippet: string | null = null;
  let outcome: 'success' | 'permanent' | 'retryable';

  const start = Date.now();
  try {
    const res = await fetch(ctx.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-id': ctx.eventId,
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': `sha256=${signature}`,
      },
      body,
      // Hard timeout so a hanging receiver can never block the worker.
      signal: AbortSignal.timeout(env.DELIVERY_TIMEOUT_MS),
    });

    statusCode = res.status;
    responseSnippet = (await res.text().catch(() => '')).slice(0, SNIPPET_MAX);

    if (res.ok) {
      outcome = 'success';
    } else if (isRetryableStatus(res.status)) {
      outcome = 'retryable';
    } else {
      outcome = 'permanent';
    }
  } catch (err) {
    // Timeout (AbortError/TimeoutError) or network error -> always retryable.
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    outcome = 'retryable';
  } finally {
    // Release the concurrency slot as soon as the HTTP call is done.
    await slot.release();
  }
  const latencyMs = Date.now() - start;

  // Record every attempt in the immutable log, success or failure.
  await recordAttempt({ deliveryId, attemptNumber, statusCode, latencyMs, error, responseSnippet });

  if (outcome === 'success') {
    await onSuccess(ctx.endpointId); // close the breaker
    await markSucceeded(deliveryId, attemptNumber);
    logger.info({ deliveryId, attemptNumber, statusCode, latencyMs }, 'delivery succeeded');
    return;
  }

  if (outcome === 'permanent') {
    // A permanent 4xx is a client error, not an availability problem, so it does
    // NOT trip the circuit breaker.
    const reason = `permanent HTTP ${statusCode}`;
    await markFailed(deliveryId, attemptNumber, reason);
    logger.warn({ deliveryId, attemptNumber, statusCode }, 'delivery failed permanently (no retry)');
    return; // do NOT throw -> BullMQ will not retry
  }

  // Retryable failure -> counts toward the circuit breaker.
  await onFailure(ctx.endpointId);
  const reason = error ?? `retryable HTTP ${statusCode}`;
  const isLastAttempt = attemptNumber >= maxAttempts;

  if (isLastAttempt) {
    await markDead(deliveryId, attemptNumber, reason);
    logger.error({ deliveryId, attemptNumber, reason }, 'delivery dead (attempts exhausted)');
  } else {
    // next_attempt_at is an observability estimate; BullMQ owns the real timer.
    const nextDelayMs = backoffDelay(attemptNumber);
    await markPendingRetry(deliveryId, attemptNumber, nextDelayMs, reason);
    logger.warn(
      { deliveryId, attemptNumber, statusCode, reason, nextDelayMs },
      'delivery failed; will retry'
    );
  }

  // Throw so BullMQ schedules the retry (or, on the last attempt, moves the job
  // to the failed set — retained for the CP4 DLQ since removeOnFail is false).
  throw new Error(`delivery ${deliveryId} attempt ${attemptNumber} failed: ${reason}`);
}
