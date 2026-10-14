import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

/**
 * Shared Redis client. BullMQ will use its own connections later, but this one
 * backs the health check and any direct Redis use. `maxRetriesPerRequest: null`
 * is the setting BullMQ expects, so we adopt it now for consistency.
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

// ioredis auto-reconnects, but an unhandled 'error' event would still crash the
// process. Log it and let ioredis recover.
redis.on('error', (err) => {
  logger.error({ err: err.message }, 'redis connection error (will reconnect)');
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
