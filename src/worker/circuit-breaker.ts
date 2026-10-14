import { redis } from '../lib/redis';
import { env } from '../config/env';

/**
 * Per-endpoint circuit breaker: closed -> open -> half-open -> closed.
 *
 *  - closed: deliveries flow normally. CB_FAILURE_THRESHOLD consecutive failures
 *    trip it OPEN.
 *  - open: for CB_OPEN_MS we skip the actual POST and fast-fail (which still
 *    consumes a retry attempt, so a truly-dead endpoint still reaches the DLQ —
 *    the breaker just saves the network call and the full timeout wait).
 *  - half-open: after the cooldown, a limited number of trial deliveries are
 *    allowed. A success closes the breaker; a failure re-opens it.
 *
 * State lives in a Redis hash so it is shared across worker instances. This is a
 * pragmatic (non-Lua) implementation — good enough for per-endpoint gating;
 * strict atomicity across racing workers would use a Lua script.
 */
export type Gate = 'closed' | 'half-open' | 'open';

function key(endpointId: string): string {
  return `cb:${endpointId}`;
}

/** Decide whether a delivery may proceed, performing the open->half transition. */
export async function checkGate(endpointId: string): Promise<Gate> {
  const k = key(endpointId);
  const state = (await redis.hget(k, 'state')) ?? 'closed';

  if (state === 'open') {
    const openedAt = Number((await redis.hget(k, 'openedAt')) ?? 0);
    if (Date.now() - openedAt < env.CB_OPEN_MS) {
      return 'open'; // still cooling down
    }
    // Cooldown elapsed: move to half-open and allow a limited number of trials.
    await redis.hset(k, 'state', 'half-open');
    const trials = await redis.hincrby(k, 'halfOpenInFlight', 1);
    return trials <= env.CB_HALF_OPEN_MAX ? 'half-open' : 'open';
  }

  if (state === 'half-open') {
    const trials = await redis.hincrby(k, 'halfOpenInFlight', 1);
    return trials <= env.CB_HALF_OPEN_MAX ? 'half-open' : 'open';
  }

  return 'closed';
}

/** Record a success: reset to fully closed. */
export async function onSuccess(endpointId: string): Promise<void> {
  await redis.del(key(endpointId));
}

/** Record a failure: count consecutive failures and trip open at the threshold. */
export async function onFailure(endpointId: string): Promise<void> {
  const k = key(endpointId);
  const state = (await redis.hget(k, 'state')) ?? 'closed';

  // A failed half-open trial immediately re-opens the breaker.
  if (state === 'half-open') {
    await redis.hset(k, 'state', 'open', 'openedAt', String(Date.now()), 'halfOpenInFlight', '0');
    return;
  }

  const failures = await redis.hincrby(k, 'failures', 1);
  if (failures >= env.CB_FAILURE_THRESHOLD) {
    await redis.hset(k, 'state', 'open', 'openedAt', String(Date.now()), 'halfOpenInFlight', '0');
  }
}
