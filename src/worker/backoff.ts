import { env } from '../config/env';

/**
 * Exponential backoff with FULL jitter.
 *
 *   exp   = min(cap, base * 2^(attemptsMade - 1))
 *   delay = random() * exp        // full jitter: uniform in [0, exp)
 *
 * `attemptsMade` is BullMQ's post-increment count: 1 after the first failure,
 * 2 after the second, and so on. So with base=1s the un-jittered schedule is
 * ~1s, 2s, 4s, 8s, 16s, ... capped at `cap`.
 *
 * Full jitter spreads retries across the window instead of firing them all at
 * the same instant — without it, a receiver that was down and recovers gets a
 * synchronized "thundering herd" of every pending delivery at once.
 */
export function backoffDelay(attemptsMade: number): number {
  const exp = Math.min(env.BACKOFF_CAP_MS, env.BACKOFF_BASE_MS * 2 ** (attemptsMade - 1));
  return Math.floor(Math.random() * exp);
}
