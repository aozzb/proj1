import Redis from 'ioredis';
import { env } from '../config/env';

/**
 * Shared Redis client. BullMQ will use its own connections later, but this one
 * backs the health check and any direct Redis use. `maxRetriesPerRequest: null`
 * is the setting BullMQ expects, so we adopt it now for consistency.
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

/** Lightweight liveness probe used by /health. */
export async function pingRedis(): Promise<void> {
  const reply = await redis.ping();
  if (reply !== 'PONG') {
    throw new Error(`Unexpected Redis PING reply: ${reply}`);
  }
}

export async function closeRedis(): Promise<void> {
  await redis.quit();
}
