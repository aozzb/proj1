import { redis } from '../lib/redis';
import { env } from '../config/env';

/**
 * Per-endpoint backpressure: a fixed-window rate limit and an in-flight
 * concurrency cap, both in Redis so they hold across all worker instances.
 *
 * Backpressure is NOT failure — when a limit is hit the caller should reschedule
 * the job (BullMQ moveToDelayed) without consuming a retry attempt.
 */
export interface Acquired {
  ok: boolean;
  reason?: string;
  /** Release the concurrency slot. Safe to call once; no-op if nothing acquired. */
  release: () => Promise<void>;
}

const noop = async () => undefined;

export async function acquire(
  endpointId: string,
  rateLimitPerSec: number | null,
  maxConcurrency: number | null
): Promise<Acquired> {
  const rate = rateLimitPerSec ?? env.ENDPOINT_RATE_LIMIT_PER_SEC;
  const maxConc = maxConcurrency ?? env.ENDPOINT_MAX_CONCURRENCY;

  // 1. Rate limit: fixed 1s window counter.
  const windowKey = `rl:${endpointId}:${Math.floor(Date.now() / 1000)}`;
  const count = await redis.incr(windowKey);
  if (count === 1) await redis.expire(windowKey, 2);
  if (count > rate) {
    return { ok: false, reason: 'rate-limited', release: noop };
  }

  // 2. Concurrency cap: in-flight counter, released after the POST. A safety TTL
  // means a crashed worker's slot self-heals instead of leaking forever.
  const concKey = `cc:${endpointId}`;
  const inFlight = await redis.incr(concKey);
  await redis.expire(concKey, 60);
  if (inFlight > maxConc) {
    await redis.decr(concKey);
    return { ok: false, reason: 'concurrency-capped', release: noop };
  }

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await redis.decr(concKey).catch(() => undefined);
  };
  return { ok: true, release };
}
